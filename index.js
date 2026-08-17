/* EchoRemote —— EchoMusic 局域网遥控插件
 * 架构: 插件 webServer(仅监听 127.0.0.1)+ 插件目录 bin/ 下的 bridge 桥接程序(监听 0.0.0.0),
 * 桥接程序把局域网流量反向代理到插件 webServer。
 * 手机/平板等局域网设备浏览器打开 http://<电脑局域网IP>:<端口> 即可遥控播放。
 *
 * manifest 能力: webServer(回环 HTTP 服务)+ process(启动 bridge 桥接程序)。
 */

const PLUGIN_VERSION = "1.4.1";
const DEFAULT_SETTINGS = { port: 1987, autoStart: true };
const INFO_POLL_MS = 4000;
const PLAY_MODES = ["sequential", "list", "random", "single"];
const PLAY_MODE_LABELS = { sequential: "顺序播放", list: "列表循环", random: "随机播放", single: "单曲循环" };

let ctx = null;
let settings = { ...DEFAULT_SETTINGS };
let status = null; // Vue reactive: { running, urls, message }
let bridgePid = 0;
let loopbackPort = 0;
let bridgePort = 0;
let infoTimer = null;
let infoFailures = 0;
let firstInfoReported = false;
let urls = [];
let coverCache = null; // { key, bytes, contentType }
let placeholderCache = null; // { key, bytes, contentType }
let lastAccent = "#31cfa1";
let lastAccentTrackId = "";

// ---------------- 小工具 ----------------

const clampNumber = (v, min, max, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const clampPort = (v) => Math.round(clampNumber(v, 1024, 65535, 1987));

function decodeDataUrl(url) {
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const meta = url.slice(5, comma);
  const isBase64 = /;base64$/i.test(meta);
  const mime = (meta.split(";")[0] || "image/svg+xml").toLowerCase();
  const payload = url.slice(comma + 1);
  try {
    if (isBase64) {
      const bin = atob(payload);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return { bytes, contentType: mime };
    }
    return { bytes: new TextEncoder().encode(decodeURIComponent(payload)), contentType: mime };
  } catch {
    return null;
  }
}

// ---------------- 设置 ----------------

async function loadSettings() {
  const saved = await ctx.storage.get("settings");
  settings = { ...DEFAULT_SETTINGS, ...(saved && typeof saved === "object" ? saved : {}) };
  settings.port = clampPort(settings.port);
  settings.autoStart = Boolean(settings.autoStart);
  delete settings.token; // 清理旧版本遗留
  return settings;
}

async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  settings.port = clampPort(settings.port);
  settings.autoStart = Boolean(settings.autoStart);
  delete settings.token;
  await ctx.storage.set("settings", settings);
  return settings;
}

// ---------------- 桥接程序 ----------------

function bridgeCandidates() {
  const platform = ctx.electron?.platform || "win32";
  if (platform === "win32") return ["bin/bridge-x64.exe"];
  if (platform === "darwin") return ["bin/bridge-macos-arm64", "bin/bridge-macos-x64"];
  return ["bin/bridge-x64", "bin/bridge-arm64"];
}

async function launchBridge() {
  const candidates = bridgeCandidates();
  let lastError = "";
  for (const exe of candidates) {
    let result;
    try {
      result = await ctx.process.launch({
        executable: exe,
        args: [
          "--listen", "0.0.0.0:" + settings.port,
          "--target", "http://127.0.0.1:" + loopbackPort,
        ],
      });
    } catch (err) {
      lastError = String(err?.message || err);
      continue;
    }
    if (result && result.ok) {
      bridgePid = result.pid || 0;
      return true;
    }
    if (result && result.canceled) {
      status.message = "已取消启动桥接程序,局域网功能不可用(重新点击「启动服务」可再次尝试)。";
      return false;
    }
    lastError = (result && result.error) || "启动失败";
  }
  status.message = "桥接程序启动失败: " + lastError + "(请确认插件目录 bin/ 下存在对应平台的桥接程序)";
  return false;
}

// 桥接程序通过 POST /__bridge-report 主动上报; /__info 轮询作为补充。
function applyBridgeInfo(info) {
  const port = bridgePort || settings.port;
  const rawIps = Array.isArray(info.ips) && info.ips.length ? info.ips : (typeof info.ip === "string" && info.ip ? [info.ip] : []);
  const list = rawIps
    .filter((ip) => typeof ip === "string" && ip && ip !== "127.0.0.1" && ip !== "::1" && !ip.startsWith("169.254"))
    .map((ip) => (ip.includes(":") ? "http://[" + ip + "]:" + port : "http://" + ip + ":" + port));
  infoFailures = 0;
  status.message = "";
  if (list.length) {
    urls = list;
    status.urls = list.slice();
    status.running = true;
    if (!firstInfoReported) {
      firstInfoReported = true;
      ctx.toast.success("局域网遥控已启动: " + list[0]);
    }
  }
}

function startInfoPolling() {
  stopInfoPolling();
  const tick = async () => {
    const port = bridgePort;
    if (!port) return;
    // 旧版本宿主可能没有 ctx.net.fetch:此时完全依赖桥接程序主动上报,不做轮询
    if (!ctx.net?.fetch) return;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 2500);
      const resp = await ctx.net.fetch("http://127.0.0.1:" + port + "/__info", {
        signal: ctrl.signal,
        cache: "no-store",
      });
      clearTimeout(timer);
      if (!resp.ok) throw new Error("bad status " + resp.status);
      const info = await resp.json();
      if (!info || !info.ok) throw new Error("bad payload");
      applyBridgeInfo(info);
    } catch {
      infoFailures += 1;
      if (infoFailures >= 3 && !status.urls.length) {
        status.message = "暂未获取到局域网地址。可在 cmd 运行 ipconfig 查看 IPv4 后,让手机访问 http://<IP>:" + port + "。";
      }
    }
  };
  infoTimer = setInterval(tick, INFO_POLL_MS);
  tick();
}

function stopInfoPolling() {
  if (infoTimer) { clearInterval(infoTimer); infoTimer = null; }
}

async function startService() {
  await stopService(true);
  const listen = await ctx.webServer.listen(handleRequest);
  if (!listen || !listen.ok) throw new Error((listen && listen.error) || "本地服务启动失败");
  loopbackPort = listen.port;
  bridgePort = settings.port;
  const launched = await launchBridge();
  if (!launched) {
    try { await ctx.webServer.close(); } catch {}
    loopbackPort = 0;
    bridgePort = 0;
    status.running = false;
    return;
  }
  status.running = true;
  status.message = "";
  firstInfoReported = false;
  infoFailures = 0;
  startInfoPolling();
  ctx.toast.info("正在启动局域网服务(端口 " + bridgePort + ")…");
}

async function stopService(silent) {
  stopInfoPolling();
  if (bridgePid) {
    try { await ctx.process.terminate(bridgePid); } catch {}
    bridgePid = 0;
  }
  if (loopbackPort) {
    try { await ctx.webServer.close(); } catch {}
    loopbackPort = 0;
  }
  bridgePort = 0;
  urls = [];
  status.running = false;
  status.urls = [];
  status.message = "";
  firstInfoReported = false;
  if (!silent) ctx.toast.info("局域网遥控已停止");
}

// ---------------- HTTP 请求处理 ----------------

async function readJsonBody(request) {
  try {
    if (!request.body || !request.body.byteLength) return null;
    const text = new TextDecoder("utf-8").decode(new Uint8Array(request.body));
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function jsonResponse(data, statusCode) {
  return { status: statusCode || 200, body: data };
}

function imageResponse(bytes, contentType) {
  return {
    status: 200,
    headers: { "content-type": contentType, "cache-control": "public, max-age=300" },
    body: bytes,
  };
}

// 快速路径:全部从渲染进程内读取(零 IPC),亚毫秒级响应
function buildStateFast() {
  const store = ctx.player?.store;
  const track = ctx.player?.currentTrack?.value ?? store?.currentTrackSnapshot ?? null;
  const currentTime = Number(ctx.player?.currentTime?.value ?? store?.currentTime);
  const updatedAt = Number(store?.currentTimeUpdatedAt ?? Date.now());
  const duration = Number(ctx.player?.duration?.value ?? store?.duration ?? track?.duration);
  const isPlaying = Boolean(ctx.player?.isPlaying?.value ?? store?.isPlaying ?? false);
  const playbackRate = Number(ctx.player?.playbackRate?.value ?? store?.playbackRate ?? 1);
  const rawVol = ctx.player?.volume?.value ?? store?.volume;
  const volume = Number.isFinite(rawVol) ? Math.round(rawVol > 1 ? rawVol : rawVol * 100) : 100;
  const playMode = ctx.player?.playMode?.value ?? store?.playMode ?? "list";
  const trackId = track ? String(track.id ?? track.songId ?? track.mixSongId ?? "") : "";
  const accent = ctx.stores?.theme?.sourceColor || lastAccent;
  if (accent && trackId && trackId !== lastAccentTrackId) {
    lastAccentTrackId = trackId;
    lastAccent = accent; // 切歌时才更新,避免主题过渡动画的中间色
  }
  let playback = null;
  if (track && track.title) {
    playback = {
      trackId,
      title: track.title,
      artist: track.artist || "",
      album: track.album || track.albumName || "",
      duration: Number.isFinite(duration) && duration > 0 ? duration : Number(track.duration) || 0,
      currentTime: Number.isFinite(currentTime) ? currentTime : 0,
      isPlaying,
      playbackRate: Number.isFinite(playbackRate) ? playbackRate : 1,
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : Date.now(),
      isFavorite: Boolean(track.isFavorite),
    };
  }
  return {
    serverTime: Date.now(),
    playback,
    volume,
    playMode,
    accentColor: accent || "#31cfa1",
    isDark: true,
  };
}

// 能力探测:存在进程内快照字段才走快速路径(否则回退 IPC 快照)
let fastMode = null;

async function buildStateIpc() {
  let pb = null;
  let accent = "#31cfa1";
  try {
    const snap = await ctx.nowPlaying.getSnapshot();
    if (snap) {
      pb = snap.playback || null;
      accent = snap.appearance?.accentColor || accent;
    }
  } catch {}
  lastAccent = accent;
  const rawVol = ctx.player.volume?.value;
  const volume = Number.isFinite(rawVol) ? Math.round(rawVol > 1 ? rawVol : rawVol * 100) : 100;
  return {
    serverTime: Date.now(),
    playback: pb
      ? {
          trackId: pb.trackId,
          title: pb.title,
          artist: pb.artist,
          album: pb.album || "",
          duration: pb.duration,
          currentTime: pb.currentTime,
          isPlaying: pb.isPlaying,
          playbackRate: pb.playbackRate,
          updatedAt: pb.updatedAt,
          isFavorite: pb.isFavorite,
        }
      : null,
    volume,
    playMode: ctx.player.playMode?.value || "list",
    accentColor: accent,
    isDark: true,
  };
}

function buildState() {
  if (fastMode === null) {
    fastMode =
      ctx.player?.currentTrack?.value !== undefined ||
      ctx.player?.store?.currentTrackSnapshot !== undefined;
  }
  if (fastMode) {
    try {
      return buildStateFast();
    } catch {
      fastMode = false;
    }
  }
  return buildStateIpc();
}

async function loadCoverBytes(url) {
  if (url.startsWith("data:")) return decodeDataUrl(url);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const resp = await ctx.net.fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const buf = new Uint8Array(await resp.arrayBuffer());
    if (!buf.length) return null;
    return {
      bytes: buf,
      contentType: String(resp.headers.get("content-type") || "image/jpeg").split(";")[0],
    };
  } catch {
    return null;
  }
}

async function getPlaceholder() {
  const key = lastAccent;
  if (placeholderCache && placeholderCache.key === key) return placeholderCache;
  try {
    const url = ctx.cover?.createThemedIconCoverUrl
      ? ctx.cover.createThemedIconCoverUrl({ icon: ctx.icons?.iconMusic, color: lastAccent })
      : null;
    const decoded = url ? decodeDataUrl(url) : null;
    if (decoded) {
      placeholderCache = { key, bytes: decoded.bytes, contentType: decoded.contentType };
      return placeholderCache;
    }
  } catch {}
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256"><rect width="256" height="256" fill="#161a20"/><circle cx="128" cy="128" r="48" fill="#31cfa1" opacity="0.9"/></svg>';
  placeholderCache = { key, bytes: new TextEncoder().encode(svg), contentType: "image/svg+xml" };
  return placeholderCache;
}

async function coverResponse() {
  let coverUrl = "";
  let trackId = "";
  try {
    const snap = await ctx.nowPlaying.getSnapshot();
    coverUrl = snap?.playback?.coverUrl || "";
    trackId = snap?.playback?.trackId || "";
  } catch {}
  const key = trackId + "|" + coverUrl;
  if (coverCache && coverCache.key === key && coverCache.bytes) {
    return imageResponse(coverCache.bytes, coverCache.contentType);
  }
  let bytes = null;
  let contentType = "image/jpeg";
  if (coverUrl) {
    const loaded = await loadCoverBytes(coverUrl);
    if (loaded) { bytes = loaded.bytes; contentType = loaded.contentType; }
  }
  if (!bytes) {
    const ph = await getPlaceholder();
    bytes = ph.bytes;
    contentType = ph.contentType;
  }
  coverCache = { key, bytes, contentType };
  return imageResponse(bytes, contentType);
}

async function runCommand(cmd) {
  const action = String(cmd.action || "");
  switch (action) {
    case "toggle": ctx.player.toggle(); break;
    case "play": ctx.player.play(); break;
    case "pause": ctx.player.pause(); break;
    case "next": ctx.player.next(); break;
    case "prev": ctx.player.prev(); break;
    case "seek": ctx.player.seek(clampNumber(cmd.time, 0, 86400, 0)); break;
    case "volume": ctx.player.setVolume(clampNumber(cmd.volume, 0, 100, 100) / 100); break;
    case "playMode": {
      const mode = String(cmd.mode || "");
      if (PLAY_MODES.includes(mode)) ctx.player.setPlayMode(mode);
      break;
    }
    case "rate": ctx.player.setPlaybackRate(clampNumber(cmd.rate, 0.5, 3, 1)); break;
    default: return { ok: false, error: "未知操作: " + action };
  }
  return { ok: true };
}

async function handleRequest(request) {
  const method = String(request.method || "GET").toUpperCase();
  const path = String(request.path || "/");
  // 桥接程序主动上报路由(来自本机回环)
  const isBridgeReport = method === "POST" && path === "/__bridge-report";

  try {
    if (method === "GET") {
      if (path === "/") {
        return { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, body: buildPage() };
      }
      if (path === "/api/state") return jsonResponse(await buildState());
      if (path === "/api/info") {
        return jsonResponse({ ok: true, port: bridgePort, urls, version: PLUGIN_VERSION });
      }
      if (path === "/api/cover") return await coverResponse();
    }
    if (isBridgeReport) {
      const body = await readJsonBody(request);
      if (body && body.ok && Array.isArray(body.ips) && body.ips.length) {
        applyBridgeInfo(body);
        return jsonResponse({ ok: true });
      }
      return jsonResponse({ ok: false, error: "bad report" }, 400);
    }
    if (method === "POST" && path === "/api/command") {
      const body = await readJsonBody(request);
      if (!body || typeof body.action !== "string") return jsonResponse({ ok: false, error: "参数错误" }, 400);
      return jsonResponse(await runCommand(body));
    }
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err?.message || err) }, 500);
  }
  return { status: 404, headers: { "content-type": "text/plain; charset=utf-8" }, body: "Not Found" };
}

// ---------------- 页面 ----------------

function buildPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0f1115">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>EchoRemote</title>
<style>
:root{--accent:#31cfa1;--bg:#0f1115;--text:#f2f4f8;--text2:rgba(242,244,248,.6);--card:rgba(255,255,255,.06)}
*{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent}
html,body{height:100%}
body{background:var(--bg);color:var(--text);font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;overflow:hidden;user-select:none;-webkit-user-select:none;touch-action:manipulation}
.bg{position:fixed;inset:-60px;background-position:center;background-size:cover;background-repeat:no-repeat;filter:blur(70px) brightness(.5) saturate(1.25);transform:scale(1.2);transition:background-image .8s ease;z-index:0}
.wrap{position:relative;z-index:1;width:min(430px,94vw);display:flex;flex-direction:column;align-items:center;gap:16px;padding:max(24px,env(safe-area-inset-top)) 0 max(28px,env(safe-area-inset-bottom))}
.top{display:flex;justify-content:space-between;align-items:center;width:100%;padding:0 4px}
.brand{font-size:13px;letter-spacing:.14em;color:var(--text2);font-weight:600}
.dot{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text2)}
.dot i{width:8px;height:8px;border-radius:50%;background:#46d39a;box-shadow:0 0 8px #46d39a}
.dot.off i{background:#e05353;box-shadow:0 0 8px #e05353}
.cover{width:min(300px,64vw);aspect-ratio:1;border-radius:22px;box-shadow:0 24px 60px rgba(0,0,0,.55);background:var(--card);overflow:hidden;flex:none}
.cover img{width:100%;height:100%;object-fit:cover;display:block;transition:opacity .45s ease;-webkit-touch-callout:none}
.meta{width:100%;display:grid;gap:4px;justify-items:center}
.title{font-size:21px;font-weight:700;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.artist{font-size:13px;color:var(--text2);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.progress{width:100%;padding:0 4px}
.times{display:flex;justify-content:space-between;font-size:11px;color:var(--text2);font-variant-numeric:tabular-nums;margin-top:6px}
.times span{transition:color .15s}
.times.drag #cur{color:var(--accent);font-weight:700}
input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:6px;border-radius:3px;background:rgba(255,255,255,.16);outline:none;cursor:pointer;display:block;touch-action:none}
input[type=range]::-webkit-slider-thumb{-webkit-appearance:none;appearance:none;width:16px;height:16px;border-radius:50%;background:var(--accent);border:none;box-shadow:0 0 10px rgba(0,0,0,.4);transition:transform .15s ease}
input[type=range]:active::-webkit-slider-thumb{transform:scale(1.1)}
input[type=range]::-moz-range-thumb{width:16px;height:16px;border-radius:50%;background:var(--accent);border:none}
input[type=range]:disabled{opacity:.35}
.controls{display:flex;align-items:center;gap:30px;padding:4px 0}
.btn{background:none;border:none;color:var(--text);cursor:pointer;display:flex;align-items:center;justify-content:center;opacity:.9;padding:6px;transition:transform .18s cubic-bezier(.34,1.56,.64,1),opacity .2s}
.btn:active{transform:scale(.86)}
.btn svg{width:36px;height:36px;pointer-events:none}
.btn.play{width:74px;height:74px;border-radius:50%;background:var(--accent);color:#0b0e12;box-shadow:0 12px 32px rgba(0,0,0,.45)}
.btn.play svg{width:34px;height:34px}
.volume{display:flex;align-items:center;gap:10px;width:100%;padding:0 4px;color:var(--text2)}
.volume svg{width:18px;height:18px;flex:none}
.volume input{flex:1;height:4px}
.volume .val{width:36px;font-size:12px;text-align:right;font-variant-numeric:tabular-nums;transition:color .15s}
.volume.drag .val{color:var(--accent);font-weight:700}
.extra{display:flex;gap:8px}
.chip{font-size:12px;color:var(--text2);background:var(--card);border:1px solid rgba(255,255,255,.08);padding:5px 14px;border-radius:999px;cursor:pointer;transition:transform .15s ease,color .15s,border-color .15s}
.chip:active{transform:scale(.94)}
.chip.active{color:var(--accent);border-color:rgba(255,255,255,.25)}
.foot{font-size:11px;color:var(--text2);opacity:.65}
</style>
</head>
<body>
<div class="bg" id="bg"></div>
<div class="wrap">
  <div class="top"><span class="brand">ECHOREMOTE</span><span class="dot" id="dot"><i></i><span id="dotText">连接中…</span></span></div>
  <div class="cover"><img id="cover" alt="封面" draggable="false"></div>
  <div class="meta"><div class="title" id="title">未在播放</div><div class="artist" id="artist">打开 EchoMusic 播放点什么吧</div></div>
  <div class="progress">
    <input type="range" id="seek" min="0" max="100" step="0.1" value="0" disabled>
    <div class="times"><span id="cur">0:00</span><span id="dur">0:00</span></div>
  </div>
  <div class="controls">
    <button class="btn" id="prev" title="上一首"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zM9.5 12l8.5 6V6z"/></svg></button>
    <button class="btn play" id="toggle" title="播放/暂停"><svg id="toggleIcon" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
    <button class="btn" id="next" title="下一首"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zM6 18l8.5-6L6 6z"/></svg></button>
  </div>
  <div class="volume">
    <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3z"/><path d="M16.5 12a4.5 4.5 0 0 0-2.5-4.03v8.05A4.5 4.5 0 0 0 16.5 12z" opacity=".75"/></svg>
    <input type="range" id="vol" min="0" max="100" step="1" value="100">
    <span class="val" id="volVal">100</span>
  </div>
  <div class="extra">
    <button class="chip" id="modeBtn" title="切换播放模式">列表循环</button>
    <button class="chip" id="rateBtn" title="切换倍速">1.0x</button>
  </div>
  <div class="foot" id="foot">EchoMusic · LAN</div>
</div>
<script>
var qs='';
var state=null,seeking=false,volDragging=false,lastCoverKey='',online=false,displayTime=-1;
var MODES=['sequential','list','random','single'];
var MODE_LABELS={sequential:'顺序播放',list:'列表循环',random:'随机播放',single:'单曲循环'};
var ICON_PLAY='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
var ICON_PAUSE='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
function $(id){return document.getElementById(id);}
function fmt(s){if(!isFinite(s))s=0;s=Math.max(0,Math.floor(s));var m=Math.floor(s/60),sec=s%60;return m+':'+(sec<10?'0':'')+sec;}
function estTime(){var p=state&&state.playback;if(!p)return 0;var t=p.currentTime||0;if(p.isPlaying)t+=(Date.now()-p.updatedAt)/1000*(p.playbackRate||1);if(p.duration>0)t=Math.min(t,p.duration);return t;}
function syncClock(){
  var p=state&&state.playback;
  if(!p||p.duration<=0){displayTime=-1;return;}
  var est=estTime();
  // 只有初始、切歌或超过 2 秒的大跳变才直接跟随服务器,否则只做单调下限,杜绝进度条回退
  if(displayTime<0||est-displayTime>2){displayTime=est;}
  else{displayTime=Math.max(displayTime,est);}
  displayTime=Math.min(Math.max(displayTime,0),p.duration);
}
function buzz(ms){try{if(navigator.vibrate){navigator.vibrate(ms||8);}}catch(e){}}
var lastTap=0;
function tapOnce(fn){return function(){var now=Date.now();if(now-lastTap<120){return;}lastTap=now;fn();};}
function setOnline(on){online=on;var d=$('dot');d.className=on?'dot':'dot off';$('dotText').textContent=on?'已连接':'连接中断';}
function paint(el,pct){el.style.background='linear-gradient(to right, var(--accent) '+pct+'%, rgba(255,255,255,.16) '+pct+'%)';}
function renderPlayBtn(){if(!state||!state.playback){$('toggleIcon').innerHTML=ICON_PLAY;return;}
  $('toggleIcon').innerHTML=state.playback.isPlaying?ICON_PAUSE:ICON_PLAY;}
function render(){
  var p=state?state.playback:null;
  if(state&&state.accentColor){document.documentElement.style.setProperty('--accent',state.accentColor);}
  if(p){
    $('title').textContent=p.title||'未知歌曲';
    $('artist').textContent=[p.artist,p.album].filter(Boolean).join(' · ');
    $('dur').textContent=fmt(p.duration);
    $('seek').disabled=false;
    $('seek').max=p.duration||0.1;
    var coverKey=p.trackId||'';
    if(coverKey!==lastCoverKey){
      lastCoverKey=coverKey;
      displayTime=-1;
      var sep=qs?'&':'?';
      var u='/api/cover'+qs+sep+'v='+encodeURIComponent(coverKey);
      var img=$('cover');
      img.style.opacity=0;
      img.onload=function(){img.style.opacity=1;$('bg').style.backgroundImage='url("'+u+'")';};
      img.onerror=function(){img.style.opacity=1;$('bg').style.backgroundImage='none';};
      img.src=u;
      try{if('mediaSession' in navigator&&navigator.mediaSession){
        navigator.mediaSession.metadata=new MediaMetadata({title:p.title,artist:p.artist,album:p.album||'',artwork:[{src:location.origin+u,sizes:'512x512',type:'image/jpeg'}]});}}catch(e){}
    }
    renderPlayBtn();
    $('modeBtn').textContent=MODE_LABELS[state.playMode]||'列表循环';
    $('rateBtn').textContent=(state.playback&&state.playback.playbackRate?state.playback.playbackRate:1).toFixed(2).replace(/\.?0+$/,'')+'x';
    syncClock();
    if(!volDragging){$('vol').value=state.volume;$('volVal').textContent=state.volume;paint($('vol'),state.volume);}
  }else{
    displayTime=-1;
    $('title').textContent='未在播放';
    $('artist').textContent='打开 EchoMusic 播放点什么吧';
    $('dur').textContent='0:00';$('cur').textContent='0:00';
    $('seek').disabled=true;$('seek').value=0;paint($('seek'),0);
    renderPlayBtn();
    $('modeBtn').textContent=MODE_LABELS[state&&state.playMode]||'列表循环';
  }
}
function post(action,data,opts){
  var body=Object.assign({action:action},data||{});
  fetch('/api/command'+qs,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),cache:'no-store'}).catch(function(){});
  if(!opts||!opts.noRefresh){quickRefresh();}
}
var quickTimer=null,quickLeft=0;
function quickRefresh(){
  quickLeft=3;
  if(quickTimer) return;
  (function burst(){
    if(quickLeft<=0){quickTimer=null;return;}
    quickLeft--;
    refresh();
    quickTimer=setTimeout(burst,250);
  })();
}
function refresh(){
  fetch('/api/state'+qs,{cache:'no-store'}).then(function(r){return r.json();}).then(function(s){state=s;setOnline(true);render();}).catch(function(){setOnline(false);});
}
var lastFrameTs=0;
function raf(ts){
  if(!lastFrameTs){lastFrameTs=ts;}
  var dt=Math.min(ts-lastFrameTs,250);
  lastFrameTs=ts;
  var p=state&&state.playback;
  if(p&&p.isPlaying&&p.duration>0&&!seeking&&displayTime>=0){
    displayTime=Math.min(displayTime+dt/1000*(p.playbackRate||1),p.duration);
  }
  if(p&&!seeking&&p.duration>0&&displayTime>=0){
    var el=$('seek');
    el.value=displayTime;
    $('cur').textContent=fmt(displayTime);
    paint(el,displayTime/p.duration*100);
  }
  requestAnimationFrame(raf);
}
$('toggle').addEventListener('click',tapOnce(function(){
  if(state&&state.playback){
    state.playback.isPlaying=!state.playback.isPlaying;
    state.playback.updatedAt=Date.now();
    state.playback.currentTime=displayTime>=0?Math.min(displayTime,state.playback.duration||displayTime):state.playback.currentTime;
  }
  renderPlayBtn();
  buzz();
  post('toggle');
}));
$('prev').addEventListener('click',tapOnce(function(){buzz();post('prev');}));
$('next').addEventListener('click',tapOnce(function(){buzz();post('next');}));
var seekEl=$('seek');
var timesEl=document.querySelector('.times');
seekEl.addEventListener('input',function(){seeking=true;timesEl.classList.add('drag');$('cur').textContent=fmt(parseFloat(seekEl.value));paint(seekEl,parseFloat(seekEl.value)/parseFloat(seekEl.max)*100);});
seekEl.addEventListener('change',function(){seeking=false;timesEl.classList.remove('drag');var t=parseFloat(seekEl.value);displayTime=t;buzz(15);post('seek',{time:t});});
var volEl=$('vol');
var volLastSent=0;
function sendVolume(v){volLastSent=Date.now();post('volume',{volume:Number(v)},{noRefresh:true});}
var volWrap=document.querySelector('.volume');
volEl.addEventListener('input',function(){
  volDragging=true;
  volWrap.classList.add('drag');
  var v=Number(volEl.value);
  $('volVal').textContent=volEl.value;
  paint(volEl,v);
  if(Date.now()-volLastSent>=80){sendVolume(v);}
});
volEl.addEventListener('change',function(){
  volDragging=false;
  volWrap.classList.remove('drag');
  buzz(15);
  sendVolume(Number(volEl.value));
});
$('modeBtn').addEventListener('click',tapOnce(function(){var cur=state&&state.playMode?state.playMode:'list';var i=MODES.indexOf(cur);var next=MODES[(i+1)%MODES.length];$('modeBtn').textContent=MODE_LABELS[next];buzz();post('playMode',{mode:next});}));
$('rateBtn').addEventListener('click',tapOnce(function(){var rates=[0.5,0.75,1,1.25,1.5,2,3];var cur=state&&state.playback?state.playback.playbackRate:1;var i=rates.indexOf(cur);var next=rates[(i+1)%rates.length];$('rateBtn').textContent=next.toFixed(2).replace(/\.?0+$/,'')+'x';buzz();post('rate',{rate:next});}));
if('mediaSession' in navigator&&navigator.mediaSession){
  try{
    navigator.mediaSession.setActionHandler('play',function(){post('play');});
    navigator.mediaSession.setActionHandler('pause',function(){post('pause');});
    navigator.mediaSession.setActionHandler('previoustrack',function(){post('prev');});
    navigator.mediaSession.setActionHandler('nexttrack',function(){post('next');});
    navigator.mediaSession.setActionHandler('seekto',function(d){if(d.seekTime!=null)post('seek',{time:d.seekTime});});
  }catch(e){}
}
setInterval(refresh,500);refresh();requestAnimationFrame(raf);
</script>
</body>
</html>`;
}

// ---------------- 设置面板 ----------------

function registerSettingsPanel() {
  const { defineComponent, h, ref, defineAsyncComponent } = ctx.vue;

  const SettingsPanel = defineComponent({
    setup() {
      const draft = ref({ port: String(settings.port), autoStart: settings.autoStart });
      const busy = ref(false);

      // 宿主 UI 组件(存在则用,缺失回退原生控件)
      const HostButton = ctx.ui?.components?.Button ? defineAsyncComponent(ctx.ui.components.Button) : null;
      const HostSwitch = ctx.ui?.components?.Switch ? defineAsyncComponent(ctx.ui.components.Switch) : null;

      const save = async () => {
        await saveSettings({ port: Number(draft.value.port), autoStart: Boolean(draft.value.autoStart) });
        ctx.toast.success("设置已保存");
      };

      const start = async () => {
        busy.value = true;
        try {
          await saveSettings({ port: Number(draft.value.port), autoStart: Boolean(draft.value.autoStart) });
          await startService();
        } catch (err) {
          ctx.toast.warning("启动失败: " + (err?.message || err));
        } finally {
          busy.value = false;
        }
      };

      const stop = async () => {
        busy.value = true;
        try { await stopService(); } finally { busy.value = false; }
      };

      const copy = async () => {
        const url = status.urls[0];
        if (!url) { ctx.toast.info("暂未获取到局域网地址,请稍候"); return; }
        try { await navigator.clipboard.writeText(url); ctx.toast.success("已复制: " + url); }
        catch { ctx.toast.warning("复制失败,请手动复制: " + url); }
      };

      // 控件封装(宿主组件优先)
      const Btn = (text, opts) =>
        HostButton
          ? h(HostButton, { size: "xs", ...opts }, { default: () => text })
          : h("button", { style: plainBtnStyle, ...opts }, text);
      const Sw = (model, onChange) =>
        HostSwitch
          ? h(HostSwitch, { modelValue: model, "onUpdate:modelValue": (v) => onChange(Boolean(v)) })
          : h("input", { type: "checkbox", checked: model, onChange: (e) => onChange(e.target.checked) });

      const S = {
        root: "display:grid;gap:12px;padding:6px 0 2px;",
        header: "display:flex;align-items:center;justify-content:space-between;",
        title: "font-size:15px;font-weight:600;color:var(--color-text-main);",
        badge: "display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:3px 10px;border-radius:999px;",
        badgeOn: "color:#46d39a;background:rgba(70,211,154,.12);border:1px solid rgba(70,211,154,.32);",
        badgeOff: "color:var(--color-text-secondary);border:1px solid var(--color-border);",
        card: "display:grid;gap:10px;background:var(--color-bg-secondary);border:1px solid var(--color-border);border-radius:12px;padding:12px 14px;",
        cardTitle: "font-size:12px;color:var(--color-text-secondary);",
        urlRow: "display:flex;align-items:center;gap:8px;",
        urlText: "flex:1;min-width:0;font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--color-text-main);background:var(--color-bg);border:1px solid var(--color-border);border-radius:8px;padding:7px 10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
        urlExtra: "font-family:ui-monospace,Consolas,monospace;font-size:11px;color:var(--color-text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
        error: "font-size:12px;color:#e05353;line-height:1.6;",
        row: "display:flex;align-items:center;justify-content:space-between;gap:12px;",
        rowLabel: "display:grid;gap:2px;font-size:13px;color:var(--color-text-main);",
        rowDesc: "font-size:11px;color:var(--color-text-secondary);",
        input: "width:110px;padding:6px 8px;border-radius:8px;border:1px solid var(--color-border);background:var(--color-bg);color:var(--color-text-main);font-size:13px;outline:none;",
        btnRow: "display:flex;gap:8px;",
        hint: "font-size:11.5px;line-height:1.7;color:var(--color-text-secondary);opacity:.9;",
      };
      const plainBtnStyle = "padding:6px 14px;border-radius:8px;border:1px solid var(--color-border);background:var(--color-bg-secondary);color:var(--color-text-main);font-size:13px;cursor:pointer;";

      return () => {
        const running = status.running;
        const primaryUrl = status.urls[0] || "";
        return h("div", { style: S.root }, [
          // 头部:标题 + 状态徽章
          h("div", { style: S.header }, [
            h("span", { style: S.title }, "局域网遥控"),
            h("span", { style: S.badge + (running ? S.badgeOn : S.badgeOff) }, [
              h("i", { style: "width:7px;height:7px;border-radius:50%;background:" + (running ? "#46d39a" : "#8b919a") + ";" }),
              running ? "运行中" : "已停止",
            ]),
          ]),
          // 地址卡片
          h("div", { style: S.card }, [
            h("span", { style: S.cardTitle }, "手机访问地址"),
            h("div", { style: S.urlRow }, [
              h("div", { style: S.urlText, title: primaryUrl }, primaryUrl || "启动服务后自动显示"),
              Btn("复制地址", { variant: "outline", disabled: busy.value, onClick: copy }),
            ]),
            ...status.urls.slice(1).map((u) => h("div", { style: S.urlExtra }, u)),
            status.message ? h("div", { style: S.error }, status.message) : null,
          ]),
          // 配置卡片
          h("div", { style: S.card }, [
            h("div", { style: S.row }, [
              h("div", { style: S.rowLabel }, [
                h("div", null, "监听端口"),
                h("div", { style: S.rowDesc }, "手机访问 http://电脑IP:端口"),
              ]),
              h("input", {
                type: "number", min: 1024, max: 65535, value: draft.value.port,
                onInput: (e) => { draft.value.port = e.target.value; },
                style: S.input,
              }),
            ]),
            h("div", { style: S.row }, [
              h("div", { style: S.rowLabel }, [
                h("div", null, "自动启动"),
                h("div", { style: S.rowDesc }, "启用插件后自动开启局域网服务"),
              ]),
              Sw(draft.value.autoStart, (v) => { draft.value.autoStart = v; }),
            ]),
          ]),
          // 操作按钮
          h("div", { style: S.btnRow }, [
            Btn(running ? "停止服务" : "启动服务", { disabled: busy.value, onClick: running ? stop : start }),
            Btn("保存设置", { variant: "outline", disabled: busy.value, onClick: save }),
          ]),
          h("div", { style: S.hint }, [
            "首次启动需在弹窗中选择「允许并记住」,Windows 防火墙提示请允许专用网络访问。手机与电脑需在同一局域网。",
            h("br"),
            "修改端口后点击「保存设置」;若服务正在运行,需先「停止服务」再「启动服务」才能生效。",
          ]),
        ]);
      };
    },
  });

  ctx.ui.settings.define({ title: "局域网遥控", component: SettingsPanel });
}

// ---------------- 生命周期 ----------------

export async function activate(pluginCtx) {
  ctx = pluginCtx;
  status = ctx.vue.reactive({ running: false, urls: [], message: "" });
  await loadSettings();
  try { registerSettingsPanel(); } catch {}
  try {
    ctx.commands?.register?.("echo-remote.toggle", () => {
      if (status.running) stopService(); else startService();
    }, { title: "切换局域网遥控" });
  } catch {}
  ctx.dispose(async () => { await stopService(true); });
  if (settings.autoStart) {
    try {
      await startService();
    } catch (err) {
      ctx.toast.warning("局域网遥控启动失败: " + (err?.message || err));
    }
  }
}

export async function deactivate() {
  await stopService(true);
}
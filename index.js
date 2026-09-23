/* EchoRemote —— EchoMusic 局域网遥控插件
 * 架构: 插件 webServer(仅监听 127.0.0.1)+ 插件目录 bin/ 下的 bridge 桥接程序(监听 0.0.0.0),
 * 桥接程序把局域网流量反向代理到插件 webServer。
 * 手机/平板等局域网设备浏览器打开 http://<电脑局域网IP>:<端口> 即可遥控播放。
 *
 * manifest 能力: webServer(回环 HTTP 服务)+ process(启动 bridge 桥接程序)。
 */

const PLUGIN_VERSION = "1.5.0";
const DEFAULT_SETTINGS = { port: 1987, autoStart: true };
const INFO_POLL_MS = 4000;
const PLAY_MODES = ["sequential", "list", "random", "single"];
const PLAY_MODE_LABELS = { sequential: "顺序播放", list: "列表循环", random: "随机播放", single: "单曲循环" };
const SEARCH_PAGE_SIZE = 30;   // 与宿主搜索页 SEARCH_PAGE_SIZE 一致
const SONG_CACHE_LIMIT = 300;  // 点歌缓存上限(超过后淘汰最早的条目)

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
let songCache = new Map(); // 搜索结果缓存: String(song.id) -> 完整 Song 对象,供点歌时回传宿主播放

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

// ---------------- 搜索与点歌 ----------------
// 字段映射与宿主 src/renderer/utils/mappers/song.ts 的 mapSearchSong 保持一致(最小集),
// 保证 ctx.player.playSong 拿到的 Song 与宿主搜索页点播时结构相同。

function formatPicUrl(value) {
  if (!value) return "";
  let pic = String(value).replace(/\{size\}/g, "400");
  if (pic.startsWith("//")) pic = "https:" + pic;
  return pic;
}

function normalizeCoverUrl(url) {
  const raw = String(url == null ? "" : url).trim();
  if (!raw) return "";
  let cover = raw.replace("http://", "https://");
  if (cover.includes("{size}")) cover = cover.replace("{size}", "400");
  return cover.replace("c1.kgimg.com", "imge.kugou.com");
}

function processSongTitle(raw) {
  if (raw.includes(" - ")) {
    const parts = raw.split(" - ");
    if (parts.length > 1) return parts.slice(1).join(" - ");
  }
  return raw;
}

function toPlainRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function pickDefined(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function readStr(v) {
  return v === undefined || v === null ? "" : String(v);
}

function readInt(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : 0;
}

function readOptInt(v) {
  if (v === undefined || v === null || v === "") return undefined;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : undefined;
}

function mapSearchItem(raw) {
  const r = toPlainRecord(raw);
  const singersRaw = Array.isArray(r.Singers) ? r.Singers : [];
  const artists = singersRaw
    .map((s) => toPlainRecord(s))
    .map((s) => ({
      id: readStr(pickDefined(s.id, s.AuthorId, s.author_id, s.singerid, s.singer_id)),
      name: readStr(pickDefined(s.name, s.AuthorName, s.author_name, s.singername)),
    }))
    .filter((a) => a.name.length > 0);
  const rawTitle = readStr(pickDefined(r.SongName, r.FileName, "未知歌曲"));
  const title = processSongTitle(rawTitle) || rawTitle;
  const artist = artists.length > 0
    ? artists.map((a) => a.name).join(", ")
    : readStr(pickDefined(r.SingerName, "未知歌手"));
  const albumName = readStr(pickDefined(r.AlbumName, ""));
  const cover = normalizeCoverUrl(formatPicUrl(r.Image));
  const relateGoods = [];
  const hq = toPlainRecord(r.HQ);
  const sq = toPlainRecord(r.SQ);
  const hiRes = toPlainRecord(r.Res);
  if (hq.Hash) relateGoods.push({ hash: readStr(hq.Hash), quality: "320" });
  if (sq.Hash) relateGoods.push({ hash: readStr(sq.Hash), quality: "flac" });
  if (hiRes.Hash) relateGoods.push({ hash: readStr(hiRes.Hash), quality: "high" });
  return {
    id: readStr(pickDefined(r.MixSongID, r.Auditoid, r.Audioid, r.FileHash, "")),
    title: rawTitle || "未知歌曲",
    name: title || "未知歌曲",
    artist,
    artists,
    singers: artists,
    album: albumName,
    albumName,
    albumId: readStr(pickDefined(r.AlbumID, r.AlbumId, r.albumid, "")),
    duration: readInt(pickDefined(r.Duration, 0)),
    coverUrl: cover,
    cover,
    audioUrl: "",
    hash: readStr(pickDefined(r.FileHash, "")),
    mvHash: readStr(pickDefined(r.video_hash, r.mvhash, r.MVHash, "")),
    mixSongId: readInt(pickDefined(r.MixSongID, 0)),
    fileId: readOptInt(pickDefined(r.Auditoid, r.Audioid, r.audio_id, r.fileid, r.file_id)),
    privilege: readOptInt(r.AlbumPrivilege),
    payType: readOptInt(r.PayType),
    oldCpy: readOptInt(r.OldCpy),
    relateGoods,
    isOriginal: readInt(r.IsOriginal) === 1,
    lyricSnippet: readStr(pickDefined(r.Lyric, "")),
  };
}

// 与宿主 src/renderer/views/search/searchHelpers.ts 的提取逻辑一致
function extractSearchLists(payload) {
  const record = toPlainRecord(payload);
  const data = toPlainRecord(record.data);
  const lists = data.lists ?? data.list ?? record.lists ?? record.list;
  return Array.isArray(lists) ? lists : [];
}

function extractSearchTotal(payload) {
  const record = toPlainRecord(payload);
  const data = toPlainRecord(record.data);
  const candidates = [data.total, data.totalCount, data.count, data.counts, record.total, record.totalCount, record.count, record.counts];
  for (const c of candidates) {
    if (typeof c === "number" && Number.isFinite(c)) return c;
    if (typeof c === "string" && c.trim()) {
      const parsed = Number(c);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

// 与宿主 src/renderer/utils/song.ts 的判定一致
const isVipSearchSong = (s) => s.privilege === 10 && s.payType === 3;
const isPlayableSearchSong = (s) =>
  Boolean(String(s.hash || "").trim() || String(s.audioUrl || "").trim()) &&
  s.privilege !== 40 &&
  !(s.privilege === 5 && s.oldCpy !== 1);

function cacheSongs(songs) {
  for (const s of songs) {
    if (s.id) songCache.set(String(s.id), s);
  }
  if (songCache.size > SONG_CACHE_LIMIT) {
    const overflow = songCache.size - SONG_CACHE_LIMIT;
    let dropped = 0;
    for (const key of songCache.keys()) {
      if (dropped >= overflow) break;
      songCache.delete(key);
      dropped += 1;
    }
  }
}

function getQueryParam(request, name) {
  const q = request.query;
  if (q && typeof q === "object") {
    const v = q[name];
    if (Array.isArray(v)) return v[0];
    if (v !== undefined) return v;
    return undefined;
  }
  try {
    const url = new URL(request.url || "", "http://localhost");
    return url.searchParams.get(name) || undefined;
  } catch {
    return undefined;
  }
}

async function handleSearchApi(request) {
  const keywords = String(getQueryParam(request, "keywords") || "").trim();
  const page = Math.round(clampNumber(getQueryParam(request, "page"), 1, 200, 1));
  if (!keywords) return jsonResponse({ ok: false, error: "缺少搜索关键词" }, 400);
  if (!ctx.kugou || !ctx.kugou.search) {
    return jsonResponse({ ok: false, error: "当前 EchoMusic 版本未提供搜索接口,请升级宿主" }, 501);
  }
  if (keywords.length > 100) return jsonResponse({ ok: false, error: "关键词过长" }, 400);
  try {
    const resp = await ctx.kugou.search.search(keywords, "song", page, SEARCH_PAGE_SIZE);
    const lists = extractSearchLists(resp);
    const total = extractSearchTotal(resp);
    const songs = lists.map(mapSearchItem).filter((s) => s.id);
    cacheSongs(songs);
    return jsonResponse({
      ok: true,
      page,
      total,
      hasMore: total !== null ? page * SEARCH_PAGE_SIZE < total : songs.length >= SEARCH_PAGE_SIZE,
      songs: songs.map((s) => ({
        id: s.id,
        title: s.name || s.title,
        artist: s.artist,
        album: s.albumName || "",
        duration: s.duration,
        coverUrl: s.coverUrl || "",
        vip: isVipSearchSong(s),
        playable: isPlayableSearchSong(s),
      })),
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err?.message || err) }, 500);
  }
}

// ---------------- 播放队列 ----------------
// 与宿主 src/renderer/components/music/PlayerQueueDrawer.vue 的行为保持一致:
// 读队列用 ctx.playlist.getActiveQueue/getQueueSongs,切歌用 ctx.player.playTrack(id, { playlist, sourceQueueId })。
// 该 API 无需额外 capability 声明。

const QUEUE_PAGE_SIZE = 100;

function playerStore() {
  return ctx.player?.store || null;
}

function currentTrackId() {
  const v = ctx.player?.currentTrackId?.value;
  if (v !== undefined && v !== null) return String(v);
  const store = playerStore();
  return store && store.currentTrackId != null ? String(store.currentTrackId) : "";
}

// 与宿主 currentPlaybackQueue 一致:来源队列 → 活动队列 → 最近队列
function resolveCurrentQueue(playlist) {
  const store = playlist.store || {};
  const sourceId = store.currentSourceQueueId;
  if (sourceId !== undefined && sourceId !== null && sourceId !== "") {
    try {
      const bySource = playlist.getQueue?.(sourceId);
      if (bySource) return bySource;
    } catch {}
  }
  try {
    const active = playlist.getActiveQueue?.();
    if (active) return active;
  } catch {}
  try {
    const recent = store.recentPlaybackQueues;
    if (Array.isArray(recent) && recent.length) return recent[0];
  } catch {}
  return null;
}

// 云端/持久化队列的 songs 可能是懒加载的,先按 songCount 补齐
async function queueSongsOf(playlist, queue) {
  let songs = Array.isArray(queue?.songs) ? queue.songs.slice() : [];
  if (songs.length) return songs;
  if (!queue?.id || !(Number(queue.songCount) > 0)) return songs;
  const store = playlist.store || {};
  if (typeof store.ensurePlaybackQueueSongsLoaded === "function") {
    try { await store.ensurePlaybackQueueSongsLoaded(queue.id); } catch {}
  } else if (typeof store.loadPlaybackQueueFromStorage === "function") {
    try { await store.loadPlaybackQueueFromStorage(queue.id); } catch {}
  }
  try {
    const reloaded = playlist.getQueue?.(queue.id);
    if (reloaded && Array.isArray(reloaded.songs)) songs = reloaded.songs.slice();
  } catch {}
  return songs;
}

function queueSongBrief(song, index, playingId) {
  const id = String(song?.id ?? "");
  return {
    index,
    id,
    title: song?.title || song?.name || "未知歌曲",
    artist: song?.artist || "",
    album: song?.album || song?.albumName || "",
    duration: Number(song?.duration) || 0,
    coverUrl: song?.coverUrl || "",
    isCurrent: Boolean(playingId) && id === playingId,
  };
}

function queueBrief(queue, isActive) {
  const songs = Array.isArray(queue.songs) ? queue.songs : [];
  return {
    id: String(queue.id ?? ""),
    title: queue.title || queue.subtitle || "播放队列",
    subtitle: queue.subtitle || "",
    type: queue.type || "",
    songCount: Number(queue.songCount) || songs.length,
    isActive: Boolean(isActive),
  };
}

function activateQueue(playlist, queueId) {
  try { playlist.setActiveQueue?.(queueId); } catch {}
  const store = playerStore();
  if (store) {
    try { store.currentSourceQueueId = queueId; } catch {}
  }
}

async function handleQueueApi(request) {
  const playlist = ctx.playlist;
  if (!playlist || typeof playlist.getActiveQueue !== "function") {
    return jsonResponse({ ok: false, error: "当前 EchoMusic 版本未提供播放队列接口,请升级宿主" }, 501);
  }
  const limit = Math.round(clampNumber(getQueryParam(request, "limit"), 1, 500, QUEUE_PAGE_SIZE));
  const around = getQueryParam(request, "around") !== undefined;
  try {
    const queue = resolveCurrentQueue(playlist);
    if (!queue) {
      if (getQueryParam(request, "meta") !== undefined) {
        return jsonResponse({ ok: true, meta: true, queueId: "", total: 0, currentIndex: -1, currentTrackId: "" });
      }
      return jsonResponse({ ok: true, queue: null, songs: [], total: 0, offset: 0, limit, currentIndex: -1, hasMore: false, hasPrev: false });
    }
    const songs = await queueSongsOf(playlist, queue);
    const playingId = currentTrackId();
    const currentIndex = playingId ? songs.findIndex((s) => String(s.id) === playingId) : -1;
    // meta=1:面板打开期间的轻量轮询,只回报是否变化,不返回歌曲数组
    if (getQueryParam(request, "meta") !== undefined) {
      return jsonResponse({
        ok: true,
        meta: true,
        queueId: String(queue.id),
        total: songs.length,
        currentIndex,
        currentTrackId: playingId,
      });
    }
    // around=1:返回以当前曲目为中心的窗口,前端据此一次加载并滚动定位
    const offset = around && currentIndex >= 0
      ? Math.max(0, currentIndex - Math.floor(limit / 2))
      : Math.round(clampNumber(getQueryParam(request, "offset"), 0, 1000000, 0));
    const slice = songs.slice(offset, offset + limit).map((s, i) => queueSongBrief(s, offset + i, playingId));
    return jsonResponse({
      ok: true,
      queue: queueBrief(queue, true),
      total: songs.length,
      offset,
      limit,
      currentIndex,
      currentTrackId: playingId,
      hasMore: offset + slice.length < songs.length,
      hasPrev: offset > 0,
      songs: slice,
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err?.message || err) }, 500);
  }
}

// ---------------- 歌词 ----------------
// 宿主 stores/lyric.ts:lines[].time 单位为「秒」,currentTimeOffset 单位为「毫秒」。
// 歌词内容与当前行索引都由宿主常驻维护(与歌词页是否打开无关),插件只读不写。
// 用 ctx.lyric 原始 store 而非 ctx.lyrics.getSnapshot(),是为了走和 ctx.player 一致的零 IPC 快速路径。
function lyricStoreOf() {
  return ctx.lyric || ctx.stores?.lyric || null;
}

function handleLyricApi(request) {
  try {
    const store = lyricStoreOf();
    if (!store) return jsonResponse({ ok: false, error: "当前宿主版本不支持歌词接口" }, 501);
    const query = request.query || {};
    const timeOffset = Number(store.currentTimeOffset) || 0;

    // 轻量轮询:只用于判断「换歌了」或「歌词从加载中变为已就绪」,不含歌词正文
    if (String(query.meta ?? "") === "1") {
      return jsonResponse({
        ok: true,
        meta: true,
        hash: String(store.loadedHash || ""),
        total: Array.isArray(store.lines) ? store.lines.length : 0,
        timeOffset,
      });
    }

    const raw = Array.isArray(store.lines) ? store.lines : [];
    const lines = [];
    for (const item of raw) {
      const text = String(item?.text ?? "").trim();
      if (!text) continue; // 空行(LRC 元数据行、纯间奏占位)不占版面
      lines.push({
        time: Number(item?.time) || 0,
        text,
        translated: item?.translated ? String(item.translated).trim() : "",
      });
    }
    return jsonResponse({
      ok: true,
      hash: String(store.loadedHash || ""),
      tips: String(store.tips || ""),
      total: raw.length,
      timeOffset,
      lines,
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err?.message || err) }, 500);
  }
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
    case "volume": ctx.player.setVolume(clampNumber(cmd.volume, 0, 100, 100)); break;
    case "playMode": {
      const mode = String(cmd.mode || "");
      if (PLAY_MODES.includes(mode)) ctx.player.setPlayMode(mode);
      break;
    }
    case "rate": ctx.player.setPlaybackRate(clampNumber(cmd.rate, 0.5, 3, 1)); break;
    case "playQueueSong": {
      const playlist = ctx.playlist;
      if (!playlist || typeof playlist.getActiveQueue !== "function") {
        return { ok: false, error: "当前宿主不支持播放队列接口" };
      }
      const queue = resolveCurrentQueue(playlist);
      if (!queue) return { ok: false, error: "当前没有播放队列" };
      const songs = await queueSongsOf(playlist, queue);
      const target = songs.find((s) => String(s.id) === String(cmd.songId || ""));
      if (!target) return { ok: false, error: "队列中未找到该歌曲" };
      const queueId = String(queue.id);
      if (String(target.id) === currentTrackId()) {
        // 与宿主一致:点当前曲目 = 播放/暂停切换
        ctx.player.toggle();
        return { ok: true, toggled: true };
      }
      activateQueue(playlist, queueId);
      const ok = await ctx.player.playTrack(target.id, { playlist: songs, sourceQueueId: queueId });
      if (ok === false) return { ok: false, error: "该歌曲暂不可播放(可能无版权或音源不可用)" };
      break;
    }
    case "searchPlay":
    case "searchPlayNext":
    case "searchPlayLast": {
      const song = songCache.get(String(cmd.songId || ""));
      if (!song) return { ok: false, error: "点歌记录已过期,请重新搜索后再试" };
      const ok = action === "searchPlay"
        ? await ctx.player.playSong(song)
        : action === "searchPlayNext"
          ? ctx.player.playNext(song)
          : ctx.player.playLast(song);
      if (ok === false) return { ok: false, error: "该歌曲暂不可播放(可能无版权或音源不可用)" };
      break;
    }
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
      if (path === "/api/search") return await handleSearchApi(request);
      if (path === "/api/queue") return await handleQueueApi(request);
      if (path === "/api/lyric") return handleLyricApi(request);
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
.topR{display:flex;align-items:center;gap:10px}
.sbtn{background:var(--card);border:1px solid rgba(255,255,255,.08);width:34px;height:34px;border-radius:50%;color:var(--text);display:flex;align-items:center;justify-content:center;cursor:pointer;transition:transform .15s ease,-webkit-tap-highlight-color .15s}
.sbtn:active{transform:scale(.88)}
.sbtn svg{width:16px;height:16px;pointer-events:none}
.panel{position:fixed;inset:0;z-index:5;background:rgba(15,17,21,.97);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);display:none;flex-direction:column;opacity:0;transition:opacity .22s ease}
.panel.show{display:flex;opacity:1}
.sbar{display:flex;align-items:center;gap:10px;padding:max(16px,env(safe-area-inset-top)) 16px 10px}
.sinput{flex:1;display:flex;align-items:center;gap:8px;background:var(--card);border:1px solid rgba(255,255,255,.1);border-radius:999px;padding:9px 16px}
.sinput svg{width:16px;height:16px;color:var(--text2);flex:none}
.sinput input{flex:1;min-width:0;background:none;border:none;outline:none;color:var(--text);font-size:15px;-webkit-appearance:none;appearance:none}
.sinput input::placeholder{color:var(--text2)}
.scancel{background:none;border:none;color:var(--text2);font-size:14px;cursor:pointer;padding:8px 4px;flex:none}
.sbody{flex:1;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding:2px 16px max(24px,env(safe-area-inset-bottom));position:relative}
.shint{text-align:center;color:var(--text2);font-size:13px;line-height:1.8;padding:52px 24px}
.srow{display:flex;align-items:center;gap:12px;padding:9px 2px;border-bottom:1px solid rgba(255,255,255,.05);cursor:pointer;transition:background .15s}
.srow:active{background:rgba(255,255,255,.05)}
.scov{width:46px;height:46px;border-radius:9px;background:var(--card);object-fit:cover;flex:none;-webkit-touch-callout:none}
.sinfo{flex:1;min-width:0;display:grid;gap:3px}
.stitle{font-size:14px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stitle .vip{display:inline-block;font-size:9px;color:#e8b34b;border:1px solid rgba(232,179,75,.55);border-radius:4px;padding:0 4px;margin-left:6px;vertical-align:1.5px;font-weight:700;letter-spacing:.05em}
.sartist{font-size:12px;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.srow.dis .stitle,.srow.dis .sartist,.srow.dis .scov{opacity:.38}
.srow.playing .stitle{color:var(--accent)}
.sact{flex:none;background:var(--card);border:1px solid rgba(255,255,255,.08);border-radius:999px;color:var(--text2);font-size:11px;padding:6px 11px;cursor:pointer;display:flex;align-items:center;gap:4px;transition:transform .15s ease,color .15s}
.sact:active{transform:scale(.92)}
.sact svg{width:12px;height:12px;pointer-events:none}
.smore{text-align:center;color:var(--text2);font-size:12px;padding:14px 0 6px}
.qtitle{flex:1;min-width:0;font-size:15px;font-weight:600;color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qrow{display:flex;align-items:center;gap:10px;padding:8px 2px;border-bottom:1px solid rgba(255,255,255,.05);cursor:pointer;transition:background .15s}
.qrow:active{background:rgba(255,255,255,.05)}
.qrow.cur .stitle{color:var(--accent)}
.qidx{width:20px;flex:none;display:flex;align-items:center;justify-content:center;font-size:12px;color:var(--text2);font-variant-numeric:tabular-nums}
.qidx svg{width:14px;height:14px;color:var(--accent)}
.qcov{width:42px;height:42px;border-radius:8px;background:var(--card);object-fit:cover;flex:none}
.qtime{font-size:11px;color:var(--text2);font-variant-numeric:tabular-nums;flex:none}
.qrow.flash{animation:qflash .9s ease}
@keyframes qflash{0%{background:rgba(255,255,255,.18)}100%{background:transparent}}
.lrow{padding:9px 2px;color:var(--text2);font-size:14px;line-height:1.45;text-align:center;overflow-wrap:anywhere;transition:color .2s ease,font-size .2s ease}
.lrow.cur{color:var(--accent);font-weight:700;font-size:16px}
.lrow .lsub{display:block;margin-top:3px;font-size:12px;font-weight:400;color:var(--text2);opacity:.8}
.lrow.cur .lsub{color:var(--accent);opacity:.72}
.lrow.flash{animation:qflash .9s ease}
.lnote{text-align:center;color:var(--text2);font-size:13px;line-height:1.8;padding:40px 24px}
/* 上下留白让首行/末行也能滚到正中。留白高度必须跟着滚动容器走:
   滚动容器不是整屏(并排右列只占一部分高),用 vh/百分比都会偏,
   所以两种形态都由 JS 在居中前写入按容器实测高度算出的 --lpad。
   窄屏时 .sbody 自己就是滚动容器,内边距直接生效;并排时内边距要挂到外层 .col-lyric 上。 */
#lyricBody{padding-top:var(--lpad,45vh);padding-bottom:var(--lpad,45vh)}
body.lyric-side .col-lyric #lyricBody{padding-top:0;padding-bottom:0}
/* 够宽(≥640px,含手机横屏)就把歌词改成贴在封面右侧:
   由 JS 给 body 加 .lyric-side 切换,不用媒体查询,避免两处判定不一致 */
.col-main{display:contents}
.col-lyric{display:none}
/* 歌词的滚动容器随宿主切换:窄屏是 .lyric-pane(标题栏固定在顶),
   宽屏是右侧整列 .col-lyric(标题栏绝对定位在顶)。两者共用同一套滚动规则,
   所以滚动能力不写在 #lyricBody 上,而是写在「谁在承载它」上——避免两处写一份而漂移。 */
.lyric-pane{display:flex;flex-direction:column;flex:1;min-height:0;min-width:0}
body:not(.lyric-side) .lyric-pane{overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;overscroll-behavior:contain}
/* 并排时把 pane 拆掉(display:contents):窄屏那层的 flex 容器在宽屏里会多出一层
   高度约束,导致内层留白撑不出滚动量,当前行永远滚不到正中。 */
body.lyric-side .col-lyric .lyric-pane{display:contents}
body.lyric-side .wrap{flex-direction:row;align-items:center;gap:clamp(12px,2.4vw,26px);width:min(1140px,96vw);padding:0}
/* 640px 起就要并排,所以两列都用比例而非固定值:封面列占 38% 封顶 400px,
   剩下给歌词列,窄屏时自动收窄,不会把封面挤成条。 */
body.lyric-side .col-main{display:flex;flex-direction:column;align-items:center;gap:14px;width:min(400px,38vw);flex:none;max-height:calc(100vh - 16px);overflow-y:auto;overscroll-behavior:contain;padding:2px}
body.lyric-side .cover{width:min(300px,30vh,86%)}
/* 并排右列:外层只负责定高和裁剪,不画底色——歌词区直接透出 .bg 的封面动态背景;也不滚动。
   内部拆成「固定标题栏 + 独立滚动正文」两层。
   不要用 overflow 外层 + sticky 标题栏:sticky 的吸附基准是最近的滚动祖先,
   中间隔一层 display:contents 时吸附位置不可靠,标题栏会浮到内容中间压住歌词。 */
body.lyric-side .col-lyric{position:relative;display:block;flex:1;min-width:0;height:calc(100vh - 16px);max-height:900px;overflow:hidden}
/* 标题栏(lyricBar)只负责定位,不画任何底色/渐变遮罩:
   原先这里有一条 rgba(11,14,18,.97)→透明的深色渐变,在已经透明的右列上就是一条明显的暗带,
   歌词区永远沉浸不下去。现在整条栏直接透出 .bg 的封面动态背景。
   按钮 .sbtn 的底色是 rgba(255,255,255,.06) 的半透玻璃,压在动态背景上不突兀,保留。 */
body.lyric-side .col-lyric .sbar{position:absolute;top:0;left:0;right:0;z-index:2;padding:14px 14px 8px;background:none}
/* 正文本体负责滚动,并从标题栏下方开始。
   注意:基础 .sbody 是 position:relative,这里改成 absolute 后必须把四边重新钉死,
   否则绝对定位元素会按内容撑高(clientHeight === scrollHeight),看着「有 overflow:auto」
   实际根本不滚,当前行也永远居中不了。top:58px 是给标题栏让位。 */
body.lyric-side .col-lyric .sbody{position:absolute;top:58px;left:0;right:0;bottom:0;padding:0 14px;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;scrollbar-width:none}
/* 并排态不显示滚动条(右侧那条可拖动的条):标准属性 + Blink/WebKit 双保险 */
body.lyric-side .col-lyric .sbody::-webkit-scrollbar{display:none}
/* 并排时真正的滚动容器就是 .sbody 自己,留白直接挂在它身上 */
body.lyric-side .col-lyric .sbody#lyricBody{padding-top:var(--lpad,45vh);padding-bottom:var(--lpad,45vh)}
</style>
</head>
<body>
<div class="bg" id="bg"></div>
<div class="wrap">
  <div class="col-main">
  <div class="top"><span class="brand">ECHOREMOTE</span><span class="topR"><button class="sbtn" id="lyricBtn" aria-label="歌词" title="歌词"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/></svg></button><button class="sbtn" id="queueBtn" aria-label="播放队列" title="播放列表"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h10"/></svg></button><button class="sbtn" id="searchBtn" aria-label="点歌" title="点歌"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg></button><span class="dot" id="dot"><i></i><span id="dotText">连接中…</span></span></span></div>
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
  <div class="col-lyric" id="lyricSide"></div>
</div>
</div>
<div class="panel" id="searchPanel">
  <div class="sbar">
    <div class="sinput">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <input id="searchInput" type="search" placeholder="搜索歌曲、歌手、专辑…" enterkeyhint="search" autocomplete="off">
    </div>
    <button class="scancel" id="searchCancel">取消</button>
  </div>
  <div class="sbody" id="searchBody"><div class="shint">输入关键词搜索曲库<br>点击结果播放 · 「下一首」插入队列</div></div>
</div>
<div class="panel" id="queuePanel">
  <div class="sbar">
    <span class="qtitle">播放列表</span>
    <button class="sbtn" id="queueLocate" aria-label="定位到当前播放"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg></button>
    <button class="scancel" id="queueCancel">关闭</button>
  </div>
  <div class="sbody" id="queueBody"><div class="shint">加载中…</div></div>
</div>
<div>
<div class="panel" id="lyricPanel">
  <div class="lyric-pane" id="lyricPane">
  <div class="sbar" id="lyricBar">
    <span class="qtitle">歌词</span>
    <button class="sbtn" id="lyricLocate" aria-label="定位到当前播放" title="定位到当前播放"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg></button>
    <button class="scancel" id="lyricCancel">关闭</button>
  </div>
  <div class="sbody" id="lyricBody"><div class="shint">加载中…</div></div>
  </div>
</div>
</div>
<script>
var qs='';
var state=null,seeking=false,volDragging=false,lastCoverKey='',online=false,displayTime=-1;
// 进度锚点:以宿主推送的真实 currentTime 为基准,在两次推送(≈500ms)之间做平滑外推。
// anchorAt=收到该次推送的本地时刻;raf 用它按真实流逝时长推进,而不是无脑猜播放状态。
var anchorTime=0,anchorAt=0,anchorRate=1,anchorPlaying=false;
var MODES=['sequential','list','random','single'];
var MODE_LABELS={sequential:'顺序播放',list:'列表循环',random:'随机播放',single:'单曲循环'};
var ICON_PLAY='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
var ICON_PAUSE='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';
function $(id){return document.getElementById(id);}
function fmt(s){if(!isFinite(s))s=0;s=Math.max(0,Math.floor(s));var m=Math.floor(s/60),sec=s%60;return m+':'+(sec<10?'0':'')+sec;}
// 进度锚点同步:每次宿主推送都直接跟随真实 currentTime(可上可下)。
// 修复点:
//  1) 宿主回溯/seek 时 displayTime 必须能往下跟 —— 直接取宿主 currentTime,不再做 Math.max 单调下限;
//  2) 宿主卡顿/缓冲时本地不能无脑按墙钟前进 —— 下个推送(≈500ms)会把锚点拉回真实值,进度不会跑飞
//     (仅在推送间隔内有 ≤500ms 的轻微前探,随后即被纠正)。
function syncClock(){
  var p=state&&state.playback;
  if(!p||p.duration<=0){displayTime=-1;return;}
  anchorTime=p.currentTime||0;
  anchorAt=Date.now();
  anchorRate=p.playbackRate||1;
  anchorPlaying=!!p.isPlaying;
  displayTime=Math.min(Math.max(anchorTime,0),p.duration);
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
    var tid=String(p.trackId||'');
    if(tid!==lTrackId){lTrackId=tid;if(lOpen)loadLyric();}
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
// ---- WebSocket 通道(经桥接层 /ws 终结;桥轮询插件并推送,命令反向转发) ----
// 桥不支持 /ws(旧版二进制未替换)或连接中断时,自动退回 HTTP 轮询,页面不会僵死。
var ws=null,wsRetryTimer=null,wsRetryDelay=500,wsCmdId=0,wsPending={},wantQueue=false,wantLyric=false,fbTimer=null;
function wsOpen(){return ws&&ws.readyState===1;}
function wsSend(o){if(wsOpen()){try{ws.send(JSON.stringify(o));}catch(e){}}}
function fallbackPoll(on){
  if(on&&!fbTimer){fbTimer=setInterval(refresh,500);}
  if(!on&&fbTimer){clearInterval(fbTimer);fbTimer=null;}
}
function wsConnect(){
  clearTimeout(wsRetryTimer);
  try{ws=new WebSocket((location.protocol==='https:'?'wss':'ws')+'://'+location.host+'/ws'+qs);}
  catch(e){wsRetry();return;}
  ws.onopen=function(){wsRetryDelay=500;fallbackPoll(false);syncSubs();};
  ws.onmessage=function(ev){
    var m;try{m=JSON.parse(ev.data);}catch(e){return;}
    if(!m||typeof m.t!=='string')return;
    if(m.t==='state'){
      if(m.data&&typeof m.data==='object'){state=m.data;setOnline(true);render();}
      else{setOnline(false);}
    }else if(m.t==='queueMeta'){queueMetaIn(m.data);}
    else if(m.t==='lyricMeta'){lyricMetaIn(m.data);}
    else if(m.t==='cmdres'){
      var cb=wsPending[m.id];
      if(cb){delete wsPending[m.id];cb(m.data);}
    }
  };
  ws.onclose=function(){setOnline(false);fallbackPoll(true);syncSubs();wsRetry();};
  ws.onerror=function(){};
}
function wsRetry(){
  clearTimeout(wsRetryTimer);
  wsRetryTimer=setTimeout(wsConnect,wsRetryDelay);
  wsRetryDelay=Math.min(wsRetryDelay*2,5000);
}
// 面板开关只改「想要什么」;syncSubs 统一决定走 WS 订阅还是 HTTP 兜底轮询
function syncSubs(){
  if(wsOpen()){
    if(qTimer){clearInterval(qTimer);qTimer=null;}
    if(lTimer){clearInterval(lTimer);lTimer=null;}
    wsSend({t:wantQueue?'sub':'unsub',topic:'queue'});
    wsSend({t:wantLyric?'sub':'unsub',topic:'lyric'});
  }else{
    if(wantQueue&&!qTimer){qTimer=setInterval(queueSync,2000);}
    if(!wantQueue&&qTimer){clearInterval(qTimer);qTimer=null;}
    if(wantLyric&&!lTimer){lTimer=setInterval(lyricSync,2000);}
    if(!wantLyric&&lTimer){clearInterval(lTimer);lTimer=null;}
  }
}
function post(action,data,opts){
  var body=Object.assign({action:action},data||{});
  if(wsOpen()){wsSend({t:'cmd',body:body});return;}
  fetch('/api/command'+qs,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),cache:'no-store'}).catch(function(){});
  if(!opts||!opts.noRefresh){quickRefresh();}
}
var quickTimer=null,quickLeft=0;
function quickRefresh(){
  // WS 模式下命令落地后桥会立即补推一轮 state,无需 HTTP 补拉
  if(wsOpen())return;
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
function raf(ts){
  var p=state&&state.playback;
  // 平滑外推:以宿主真实进度为锚,按真实流逝时长推进,不依赖本地对播放状态的猜测。
  // 宿主卡顿(<500ms 间隔的轻微前探会被下个推送纠正)、回溯(锚点直接下跳)都能正确处理。
  if(p&&p.duration>0&&!seeking&&displayTime>=0){
    var t=anchorTime+(anchorPlaying?(Date.now()-anchorAt)/1000*anchorRate:0);
    t=Math.min(Math.max(t,0),p.duration);
    displayTime=t;
    var el=$('seek');
    el.value=displayTime;
    $('cur').textContent=fmt(displayTime);
    paint(el,displayTime/p.duration*100);
  }
  if(lOpen)lyricTick(ts);
  requestAnimationFrame(raf);
}
$('toggle').addEventListener('click',tapOnce(function(){
  if(state&&state.playback){
    state.playback.isPlaying=!state.playback.isPlaying;
    state.playback.updatedAt=Date.now();
    state.playback.currentTime=displayTime>=0?Math.min(displayTime,state.playback.duration||displayTime):state.playback.currentTime;
    anchorPlaying=state.playback.isPlaying;anchorAt=Date.now();
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
seekEl.addEventListener('change',function(){seeking=false;timesEl.classList.remove('drag');var t=parseFloat(seekEl.value);displayTime=t;anchorTime=t;anchorAt=Date.now();buzz(15);post('seek',{time:t});});
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
$('rateBtn').addEventListener('click',tapOnce(function(){var rates=[0.5,0.75,1,1.25,1.5,2,3];var cur=state&&state.playback?state.playback.playbackRate:1;var i=rates.indexOf(cur);var next=rates[(i+1)%rates.length];$('rateBtn').textContent=next.toFixed(2).replace(/\.?0+$/,'')+'x';buzz();anchorRate=next;anchorAt=Date.now();post('rate',{rate:next});}));
if('mediaSession' in navigator&&navigator.mediaSession){
  try{
    navigator.mediaSession.setActionHandler('play',function(){post('play');});
    navigator.mediaSession.setActionHandler('pause',function(){post('pause');});
    navigator.mediaSession.setActionHandler('previoustrack',function(){post('prev');});
    navigator.mediaSession.setActionHandler('nexttrack',function(){post('next');});
    navigator.mediaSession.setActionHandler('seekto',function(d){if(d.seekTime!=null)post('seek',{time:d.seekTime});});
  }catch(e){}
}
// ---- 点歌搜索面板 ----
var panel=$('searchPanel'),sInput=$('searchInput'),sBody=$('searchBody');
var sPage=1,sHasMore=false,sLoading=false,sKeyword='',sPlayingId='';
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
var COVER_FALLBACK='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="rgba(255,255,255,.06)"/><circle cx="24" cy="24" r="10" fill="rgba(255,255,255,.14)"/></svg>');
function covFallback(img){img.onerror=null;img.src=COVER_FALLBACK;}
function openSearch(){closeQueue();closeLyric();panel.classList.add('show');setTimeout(function(){try{sInput.focus();}catch(e){}},150);}
function closeSearch(){panel.classList.remove('show');try{sInput.blur();}catch(e){}refresh();}
function markPlaying(id){
  sPlayingId=String(id||'');
  var rows=sBody.querySelectorAll('.srow');
  for(var i=0;i<rows.length;i++){rows[i].classList.toggle('playing',rows[i].getAttribute('data-id')===sPlayingId);}
}
function doSearch(kw,page){
  if(sLoading)return;
  sKeyword=kw;sPage=page;sLoading=true;
  if(page===1){sBody.innerHTML='<div class="shint">搜索中…</div>';}
  else{var m=$('sMore');if(m)m.textContent='加载中…';}
  fetch('/api/search?keywords='+encodeURIComponent(kw)+'&page='+page+qs,{cache:'no-store'})
    .then(function(r){return r.json();})
    .then(function(d){
      sLoading=false;
      if(!d.ok){sBody.innerHTML='<div class="shint">'+esc(d.error||'搜索失败')+'</div>';return;}
      sHasMore=Boolean(d.hasMore);
      if(page===1){sBody.innerHTML='';}
      if(!d.songs||!d.songs.length){
        if(page===1)sBody.innerHTML='<div class="shint">没有找到「'+esc(kw)+'」的相关结果</div>';
        sHasMore=false;return;
      }
      var frag=document.createDocumentFragment();
      d.songs.forEach(function(s){
        var row=document.createElement('div');
        row.className='srow'+(s.playable?'':' dis')+(String(s.id)===sPlayingId?' playing':'');
        row.setAttribute('data-id',String(s.id));
        row.innerHTML='<img class="scov" loading="lazy" src="'+esc(s.coverUrl||COVER_FALLBACK)+'" onerror="covFallback(this)">'+
          '<div class="sinfo"><div class="stitle">'+esc(s.title)+(s.vip?'<span class="vip">VIP</span>':'')+'</div>'+
          '<div class="sartist">'+esc([s.artist,s.album].filter(Boolean).join(' · '))+(s.duration?' · '+fmt(s.duration):'')+'</div></div>'+
          (s.playable?'<button class="sact"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 6h11v2H4zM4 11h11v2H4zM4 16h7v2H4zM17 12l4.5 3-4.5 3z"/></svg>下一首</button>':'');
        row.addEventListener('click',function(e){
          if(!s.playable){buzz(30);return;}
          buzz();
          if(e.target&&e.target.closest&&e.target.closest('.sact')){
            post('searchPlayNext',{songId:s.id});
          }else{
            post('searchPlay',{songId:s.id});
            markPlaying(s.id);
          }
        });
        frag.appendChild(row);
      });
      var anchor=page===1?null:$('sMore');
      if(anchor){anchor.parentNode.removeChild(anchor);}
      sBody.appendChild(frag);
      if(sHasMore){
        var more=document.createElement('div');
        more.className='smore';more.id='sMore';more.textContent='上滑加载更多';
        sBody.appendChild(more);
      }
    })
    .catch(function(){
      sLoading=false;
      if(page===1){sBody.innerHTML='<div class="shint">搜索请求失败,请检查与电脑的连接</div>';}
      else{var m=$('sMore');if(m)m.textContent='加载失败,上滑重试';}
    });
}
$('searchBtn').addEventListener('click',tapOnce(function(){buzz();openSearch();}));
$('searchCancel').addEventListener('click',function(){closeSearch();});
sInput.addEventListener('keydown',function(e){
  if(e.key==='Enter'){
    e.preventDefault();
    var kw=sInput.value.replace(/\\s+/g,' ').trim();
    if(kw)doSearch(kw,1);
  }
});
sBody.addEventListener('scroll',function(){
  if(!sHasMore||sLoading)return;
  if(sBody.scrollTop+sBody.clientHeight>=sBody.scrollHeight-80){doSearch(sKeyword,sPage+1);}
},{passive:true});
// ---- 播放列表面板 ----
var qPanel=$('queuePanel'),qBody=$('queueBody');
var qStart=0,qEnd=0,qTotal=0,qLoaded=false,qLoading=false,qTimer=null,qQueueId='',qCurrentId='',qCurrentRel=-1;
var PLAY_SM='<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
function postAsync(body){
  if(wsOpen()){
    // WS 模式:命令带自增 id,桥回 cmdres 按 id 关联(10s 超时兜底)
    return new Promise(function(resolve){
      var id=++wsCmdId;
      var to=setTimeout(function(){delete wsPending[id];resolve({ok:false,error:'响应超时'});},10000);
      wsPending[id]=function(d){clearTimeout(to);resolve(d||{ok:false,error:'空响应'});};
      wsSend({t:'cmd',id:id,body:body});
    });
  }
  return fetch('/api/command'+qs,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),cache:'no-store'})
    .then(function(r){return r.json();})
    .catch(function(){return {ok:false,error:'网络错误'};});
}
function openQueue(){closeSearch();closeLyric();qPanel.classList.add('show');loadQueueAround();startQueueSync();}
function closeQueue(){stopQueueSync();qPanel.classList.remove('show');}
function startQueueSync(){wantQueue=true;syncSubs();}
function stopQueueSync(){wantQueue=false;syncSubs();}
// HTTP 兜底轮询(桥不支持 WS 时才走);WS 模式下由桥的 queueMeta 推送驱动
function queueSync(){
  fetch('/api/queue?meta=1'+qs,{cache:'no-store'})
    .then(function(r){return r.json();})
    .then(queueMetaIn)
    .catch(function(){});
}
// 与 PC 端保持同步:切歌只更新高亮,队列内容变了才重新加载并定位(WS 推送与兜底轮询共用入口)
function queueMetaIn(d){
  if(!d||!d.ok||!d.meta)return;
  if(String(d.queueId)!==qQueueId||d.total!==qTotal){loadQueueAround();return;}
  var id=String(d.currentTrackId||'');
  if(id===qCurrentId)return;
  qCurrentId=id;
  var target=d.currentIndex-qStart;
  if(id&&target>=0&&target<qBody.children.length){qCurrentRel=target;markCurrent(id);}
  else{loadQueueAround();}
}
function markCurrent(id){
  var rows=qBody.querySelectorAll('.qrow');
  for(var i=0;i<rows.length;i++){
    var isCur=rows[i].getAttribute('data-id')===String(id);
    rows[i].classList.toggle('cur',isCur);
    var idx=rows[i].querySelector('.qidx');
    if(idx){var n=rows[i].getAttribute('data-index');idx.innerHTML=isCur?PLAY_SM:String(Number(n)+1);}
  }
}
function buildQueueRow(s){
  var row=document.createElement('div');
  row.className='qrow'+(s.isCurrent?' cur':'');
  row.setAttribute('data-id',s.id);
  row.setAttribute('data-index',String(s.index));
  row.innerHTML='<span class="qidx">'+(s.isCurrent?PLAY_SM:String(s.index+1))+'</span>'+
    '<img class="qcov" loading="lazy" src="'+esc(s.coverUrl||COVER_FALLBACK)+'" onerror="covFallback(this)">'+
    '<div class="sinfo"><div class="stitle">'+esc(s.title)+'</div>'+
    '<div class="sartist">'+esc([s.artist,s.album].filter(Boolean).join(' · '))+'</div></div>'+
    '<span class="qtime">'+fmt(s.duration)+'</span>';
  row.addEventListener('click',function(){
    buzz();
    postAsync({action:'playQueueSong',songId:s.id}).then(function(res){
      if(res&&res.ok===false){flashHint(res.error||'切歌失败');return;}
      if(!s.isCurrent)markCurrent(s.id);
      quickRefresh();
    });
  });
  return row;
}
// 打开面板:以当前播放曲目为中心取一段窗口,渲染后滚动定位到它
function loadQueueAround(){
  if(qLoading)return;
  qLoading=true;
  qLoaded=false;
  qBody.innerHTML='<div class="shint">加载中…</div>';
  fetch('/api/queue?around=1&limit=100'+qs,{cache:'no-store'})
    .then(function(r){return r.json();})
    .then(function(d){
      qLoading=false;
      if(!d.ok){qBody.innerHTML='<div class="shint">'+esc(d.error||'读取播放列表失败')+'</div>';return;}
      if(!d.queue){
        qStart=0;qEnd=0;qTotal=0;qQueueId='';qCurrentId='';qCurrentRel=-1;
        qBody.innerHTML='<div class="shint">当前没有播放列表</div>';
        return;
      }
      qStart=d.offset;
      qQueueId=String(d.queue.id);
      qCurrentId=String(d.currentTrackId||'');
      qCurrentRel=d.currentIndex>=0?d.currentIndex-d.offset:-1;
      qEnd=d.offset+(d.songs||[]).length;
      qTotal=d.total;
      qBody.innerHTML='';
      if(!(d.songs||[]).length){
        qBody.innerHTML='<div class="shint">这个列表还是空的<br>去搜索面板点几首歌吧</div>';
        return;
      }
      qLoaded=true;
      var frag=document.createDocumentFragment();
      d.songs.forEach(function(s){frag.appendChild(buildQueueRow(s));});
      qBody.appendChild(frag);
      locateCurrentRow(false,false);
    })
    .catch(function(){
      qLoading=false;
      qBody.innerHTML='<div class="shint">读取播放列表失败,请检查与电脑的连接</div>';
    });
}
// 滚动到当前播放那一行(需先由调用方确认 qCurrentRel 在当前已加载窗口内)
function locateCurrentRow(smooth,flash){
  if(qCurrentRel<0||qCurrentRel>=qBody.children.length)return false;
  var row=qBody.children[qCurrentRel];
  if(!row)return false;
  var top=Math.max(0,row.offsetTop-(qBody.clientHeight/2)+(row.offsetHeight/2));
  if(smooth&&typeof qBody.scrollTo==='function'){
    try{qBody.scrollTo({top:top,behavior:'smooth'});}catch(e){qBody.scrollTop=top;}
  }else{
    qBody.scrollTop=top;
  }
  if(flash)flashRow(row);
  return true;
}
function flashRow(row){
  row.classList.remove('flash');
  void row.offsetWidth;
  row.classList.add('flash');
  setTimeout(function(){row.classList.remove('flash');},950);
}
// 顶部定位按钮:当前曲目不在已加载窗口内时重新取窗口
function jumpToCurrent(){
  if(!qLoaded)return;
  if(qCurrentRel<0){flashHint('当前没有在播放的歌曲',true);return;}
  if(!locateCurrentRow(true,true))loadQueueAround();
}
// 向上/向下补载(prev=true 补更早的,插入时补偿滚动位置)
function loadQueueSide(prev){
  if(qLoading||!qLoaded)return;
  if(prev&&qStart<=0)return;
  if(!prev&&qEnd>=qTotal)return;
  var offset=prev?Math.max(0,qStart-100):qEnd;
  qLoading=true;
  fetch('/api/queue?offset='+offset+'&limit=100'+qs,{cache:'no-store'})
    .then(function(r){return r.json();})
    .then(function(d){
      qLoading=false;
      if(!d.ok||!d.songs||!d.songs.length)return;
      if(prev){
        var beforeHeight=qBody.scrollHeight;
        var first=qBody.firstChild;
        var frag=document.createDocumentFragment();
        d.songs.forEach(function(s){frag.appendChild(buildQueueRow(s));});
        qBody.insertBefore(frag,first);
        qStart=offset;
        qBody.scrollTop+=(qBody.scrollHeight-beforeHeight);
      }else{
        d.songs.forEach(function(s){qBody.appendChild(buildQueueRow(s));});
        qEnd=offset+d.songs.length;
      }
    })
    .catch(function(){qLoading=false;});
}
function flashHint(msg,neutral,host){
  var box=host||qPanel;
  var old=box.querySelector('.qToast');
  if(old&&old.parentNode)old.parentNode.removeChild(old);
  var el=document.createElement('div');
  el.className='qToast';
  el.style.cssText='position:absolute;left:50%;bottom:28px;transform:translateX(-50%);background:'+(neutral?'rgba(40,44,52,.94)':'rgba(224,83,83,.92)')+';color:'+(neutral?'var(--text)':'#fff')+';font-size:12px;padding:8px 16px;border-radius:999px;z-index:9;max-width:82%;text-align:center';
  el.textContent=msg;
  box.appendChild(el);
  setTimeout(function(){if(el.parentNode)el.parentNode.removeChild(el);},2600);
}
$('queueBtn').addEventListener('click',tapOnce(function(){buzz();openQueue();}));
$('queueCancel').addEventListener('click',function(){closeQueue();});
$('queueLocate').addEventListener('click',tapOnce(function(){buzz();jumpToCurrent();}));
qBody.addEventListener('scroll',function(){
  if(!qLoaded||qLoading)return;
  if(qBody.scrollTop+qBody.clientHeight>=qBody.scrollHeight-80){loadQueueSide(false);return;}
  if(qBody.scrollTop<60){loadQueueSide(true);}
},{passive:true});
// ---- 歌词面板 ----
// 歌词正文只在「打开面板」与「换歌 / 歌词就绪」时各拉一次;
// 当前行高亮完全由本地播放时钟推算(rAF 节流 200ms),不依赖 2s 轮询,切行跟手且不会跳。
// 够宽就把歌词贴在封面右侧,不够宽(窄屏手机竖屏)用全屏面板。
// 纯按宽度判定,不看 orientation:手机横屏宽 844/896 也算够宽,一样并排。
// 门槛 640px 是「两边还塞得下」的底线(封面列 min(400px,42vw) + 歌词列 + 间距 26px)。
// 这里是判定「够宽」的唯一出处;CSS 只认 body.lyric-side,不做媒体查询,避免两处判定漂移。
var LYRIC_WIDE='(min-width:640px)';
var lPanel=$('lyricPanel'),lPane=$('lyricPane'),lBody=$('lyricBody');
var lLines=[],lTimes=[],lOffset=0,lHash='',lRawTotal=0,lIndex=-1,lOpen=false,lLoading=false;
var lFollow=true,lTimer=null,lTickAt=0,lTrackId='',lSideOn=false;
function lyricWide(){try{return window.matchMedia(LYRIC_WIDE).matches;}catch(e){return false;}}
// 决定歌词这次挂在哪儿:够宽就挂进右列(由 CSS 把 .lyric-pane 拆成 display:contents,
// 标题栏绝对定位在列顶、.sbody 自己滚动);否则塞回全屏面板。
// 节点用 appendChild 搬移而不是复制两份 DOM,事件监听与元素引用都跟着走。
function routeLyric(){
  var wide=lyricWide();
  if(lPane.parentNode!==(wide?$('lyricSide'):lPanel)){
    (wide?$('lyricSide'):lPanel).appendChild(lPane);
  }
  lPanel.classList.toggle('show',!wide);
  document.body.classList.toggle('lyric-side',wide);
  if(lSideOn!==wide){lSideOn=wide;lIndex=-1;syncLyricPad();lyricTick(0,true);}
}
function openLyric(){
  closeSearch();closeQueue();
  lOpen=true;lFollow=true;
  routeLyric();
  // 面板刚显示出来时容器还没有高度,留白要等下一帧量才准
  requestAnimationFrame(syncLyricPad);
  loadLyric();
  startLyricSync();
}
function closeLyric(){
  if(!lOpen&&!lPanel.classList.contains('show')&&!document.body.classList.contains('lyric-side'))return;
  lOpen=false;
  stopLyricSync();
  lPanel.classList.remove('show');
  document.body.classList.remove('lyric-side');
  refresh();
}
function startLyricSync(){wantLyric=true;syncSubs();}
function stopLyricSync(){wantLyric=false;syncSubs();}
// HTTP 兜底轮询(桥不支持 WS 时才走);WS 模式下由桥的 lyricMeta 推送驱动
function lyricSync(){
  fetch('/api/lyric?meta=1'+qs,{cache:'no-store'})
    .then(function(r){return r.json();})
    .then(lyricMetaIn)
    .catch(function(){});
}
// 只做「是否需要重新拉正文」的判断:换歌(hash 变)或歌词从加载中变为就绪(total 变)
function lyricMetaIn(d){
  if(!d||!d.ok||!d.meta)return;
  lOffset=d.timeOffset||0;
  if(String(d.hash)!==lHash||Number(d.total)!==lRawTotal){loadLyric();}
}
function loadLyric(){
  if(lLoading)return;
  lLoading=true;
  fetch('/api/lyric'+qs,{cache:'no-store'})
    .then(function(r){return r.json();})
    .then(function(d){
      lLoading=false;
      if(!d.ok){renderLyricNote(d.error||'读取歌词失败');return;}
      lHash=String(d.hash||'');
      lOffset=d.timeOffset||0;
      lRawTotal=Number(d.total)||0;
      lLines=d.lines||[];
      lTimes=[];
      for(var i=0;i<lLines.length;i++){lTimes.push(Number(lLines[i].time)||0);}
      if(!lLines.length){renderLyricNote(d.tips||'暂无歌词');return;}
      renderLyricLines();
    })
    .catch(function(){lLoading=false;renderLyricNote('读取歌词失败,请检查与电脑的连接');});
}
function renderLyricNote(msg){
  lIndex=-1;lLines=[];lTimes=[];
  lBody.innerHTML='<div class="lnote">'+esc(msg)+'</div>';
}
function renderLyricLines(){
  var frag=document.createDocumentFragment();
  for(var i=0;i<lLines.length;i++){
    var line=lLines[i];
    var row=document.createElement('div');
    row.className='lrow';
    row.innerHTML=esc(line.text)+(line.translated?'<span class="lsub">'+esc(line.translated)+'</span>':'');
    frag.appendChild(row);
  }
  lBody.innerHTML='';
  lBody.appendChild(frag);
  lIndex=-1;
  lFollow=true;
  // 换过滚动容器(全屏面板 <-> 并排右列)再渲染新行时,老的 scrollTop 会残留,
  // 导致首屏当前行不在视野里。这里显式归零,再由 lyricTick 逐行居中。
  setLyricScroll(0);
  lyricTick(0,true);
}
// 二分找最后一个 time <= t 的行(歌词按 time 升序)
function lyricIndexAt(t){
  var lo=0,hi=lTimes.length-1,res=-1;
  while(lo<=hi){var mid=(lo+hi)>>1;if(lTimes[mid]<=t){res=mid;lo=mid+1;}else{hi=mid-1;}}
  return res;
}
function lyricTick(ts,instant){
  if(!lOpen||!lTimes.length)return;
  if(!instant&&ts-lTickAt<200)return;
  lTickAt=ts||0;
  var p=state&&state.playback;
  if(!p){setLyricIndex(-1,false);return;}
  var t=displayTime>=0?displayTime:(Number(p.currentTime)||0);
  setLyricIndex(lyricIndexAt(t+lOffset/1000),!instant);
}
function setLyricIndex(i,smooth){
  if(i===lIndex)return;
  var rows=lBody.children;
  if(rows[lIndex])rows[lIndex].classList.remove('cur');
  lIndex=i;
  var row=rows[i];
  if(!row)return;
  row.classList.add('cur');
  if(lFollow)scrollLyricTo(row,smooth);
}
// 歌词的滚动容器在两种形态下其实是同一个节点:.sbody(通用列表容器,自带 flex:1 + overflow:auto)。
//   窄屏 -> .sbody 直接在 .lyric-pane 里,标题栏在外层不滚
//   并排 -> .sbody 被绝对定位到标题栏下方并自己滚动(标题栏 absolute,列本身 overflow:hidden)
// 两种形态都由 #lyricBody 承载滚动,所以这里直接返回它;写死成函数是为了留一个统一出处,
// 以后若再改布局,只需改这里而不是散落在滚动/留白/复位三处。
function lyricScroller(){
  return lBody;
}
// 首尾留白:留白要挂在真正的滚动容器上,宽度不一的容器(vh / 百分比)算出来都会偏,
// 所以统一按容器实测高度写一个 --lpad。
function syncLyricPad(){
  var sc=lyricScroller();
  if(!sc)return;
  var pad=Math.round(sc.clientHeight*0.45);
  // 两种形态的留白都挂在 .sbody(= lBody)上,由 CSS 里带 body.lyric-side 前缀的规则覆盖值
  lBody.style.setProperty('--lpad',pad+'px');
}
function setLyricScroll(top){
  var sc=lyricScroller();
  if(sc)sc.scrollTop=top;
}
// row 的 offsetTop 相对 offsetParent,而 offsetParent 未必就是滚动容器,
// 用 getBoundingClientRect 折算:两坐标都含当前 scrollTop,结果是滚动容器坐标,两种形态共用一套算法。
function scrollLyricTo(row,smooth){
  var sc=lyricScroller();
  if(!sc)return;
  syncLyricPad();
  var scTop=sc.getBoundingClientRect().top;
  var cur=sc.scrollTop;
  var rowTop=row.getBoundingClientRect().top-scTop+cur;
  var top=Math.max(0,rowTop-(sc.clientHeight/2)+(row.offsetHeight/2));
  if(smooth&&typeof sc.scrollTo==='function'){
    try{sc.scrollTo({top:top,behavior:'smooth'});}catch(e){sc.scrollTop=top;}
  }else{
    sc.scrollTop=top;
  }
}
// 顶部定位按钮:手动翻过歌词后靠它回到当前行并恢复跟随
function locateLyric(){
  lFollow=true;
  if(lIndex<0){flashHint('当前没有在播放的歌曲',true,lPanel);return;}
  var row=lBody.children[lIndex];
  if(!row)return;
  scrollLyricTo(row,true);
  flashRow(row);
}
// 只有真正拖动/滚轮才暂停自动跟随(程序化滚动不会触发这两个事件)
lBody.addEventListener('touchmove',function(){lFollow=false;},{passive:true});
lBody.addEventListener('wheel',function(){lFollow=false;},{passive:true});
// 窗口尺寸跨过阈值时,歌词在「封面右侧 / 全屏面板」之间就地换位
(function(){
  var mq=null;
  try{mq=window.matchMedia(LYRIC_WIDE);}catch(e){return;}
  var onChange=function(){if(lOpen)routeLyric();};
  if(mq.addEventListener){mq.addEventListener('change',onChange);}
  else if(mq.addListener){mq.addListener(onChange);}
})();
$('lyricBtn').addEventListener('click',tapOnce(function(){
  buzz();
  // 贴在封面旁时再点一次即收起(全屏面板另有「关闭」按钮)
  if(lOpen&&document.body.classList.contains('lyric-side')){closeLyric();return;}
  openLyric();
}));
$('lyricCancel').addEventListener('click',function(){closeLyric();});
$('lyricLocate').addEventListener('click',tapOnce(function(){buzz();locateLyric();}));
refresh();fallbackPoll(true);wsConnect();requestAnimationFrame(raf);
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

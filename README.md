# EchoRemote —— EchoMusic 局域网遥控插件

在手机、平板等**同一局域网**设备上用浏览器遥控 EchoMusic 播放:

- ▶️ 播放 / 暂停、上一首 / 下一首
- 🎚️ 进度条拖拽跳转(秒级精度,本地插值平滑显示)
- 🔊 音量调节(0-100)
- 🖼️ 歌曲名、歌手、专辑与**封面**显示(模糊封面背景,自动跟随主题色)
- 🔁 播放模式切换(顺序 / 列表循环 / 随机 / 单曲循环)
- ⏩ 倍速切换(0.5x ~ 3x)

## 原理

EchoMusic 插件的 `ctx.webServer` 被宿主强制绑定在 `127.0.0.1`,无法直接监听局域网。本插件采用两级结构:

```
手机浏览器 ──http://<电脑IP>:<端口>──▶ bin/bridge(局域网桥,0.0.0.0)
                                      │ 反向代理
                                      ▼
                          插件 webServer(127.0.0.1 随机端口)
                                      │
                                      ▼
                          EchoMusic 播放器 API
```

- 桥接程序由 Zig 编写,纯标准库,无任何运行时依赖,单个可执行文件约 2.3 MB;
- 插件禁用/卸载/EchoMusic 退出时,宿主会自动终止桥接程序;
- 桥接程序只做透明转发,所有逻辑(UI、鉴权、播放控制)都在插件 JS 内。

## 安装

1. 下载本插件文件夹,放入 EchoMusic 插件目录(设置 → 插件 → 打开插件目录);
2. 插件管理页找到 **EchoRemote 局域网遥控** → 启用;
3. **首次启动**会弹出「允许插件启动本地程序」确认框,请选择**「允许并记住」**(这是宿主对 `process` 能力的强制确认);
4. Windows 防火墙如提示网络访问,勾选**专用网络**并允许;
5. 右下角弹出 `局域网遥控已启动: http://192.168.x.x:1987`,手机连接同一 WiFi 后打开该地址即可。

默认端口 **1987**,可在插件设置面板中修改端口和开机自动启动。

## 使用

- 打开页面即显示当前歌曲:封面、歌名、歌手、专辑;
- 拖进度条松手即跳转;
- 点按音量条调节音量;
- 底部两个胶囊按钮切换播放模式与倍速;
- 页面右上角圆点显示连接状态(绿=正常);
- 建议在手机上「添加到主屏幕」,体验接近原生 App;
- 手机锁屏界面可通过系统媒体会话控制播放(支持的系统)。

> ⚠️ 安全提醒:局域网内任何能访问该端口的设备都可以控制你的播放器。请只在信任的网络(家庭/公司内网)使用;不使用时可在设置面板点击「停止服务」。

## 目录结构

```
echo-remote/
  manifest.json       插件清单(webServer + process 能力)
  index.js            插件入口:HTTP 服务、API、设置面板、Web UI(全部内联)
  icon.svg            插件图标
  bin/                各平台桥接程序
    bridge-x64.exe          Windows x64
    bridge-x64              Linux x64
    bridge-arm64            Linux arm64
    bridge-macos-x64        macOS Intel
    bridge-macos-arm64      macOS Apple Silicon
  bridge-src/
    bridge.zig        桥接程序源码
```

## 自行构建桥接程序

桥接程序用 [Zig](https://ziglang.org/) 0.14.1 编写,纯标准库。安装 Zig 后:

```bash
# Windows 一键构建全部 5 个平台目标(PowerShell)
.\bridge-src\build-all.ps1

# 或手动逐个构建,例如 Windows x64:
zig build-exe bridge.zig -O ReleaseSmall -fstrip -target x86_64-windows --name bridge-x64
zig build-exe bridge.zig -O ReleaseSmall -fstrip -target x86_64-linux-musl --name bridge-x64
zig build-exe bridge.zig -O ReleaseSmall -fstrip -target aarch64-linux-musl --name bridge-arm64
zig build-exe bridge.zig -O ReleaseSmall -fstrip -target x86_64-macos --name bridge-macos-x64
zig build-exe bridge.zig -O ReleaseSmall -fstrip -target aarch64-macos --name bridge-macos-arm64
```

macOS / Linux 上首次运行前需赋予执行权限: `chmod +x bin/bridge-*`。

## 常见问题

**Q: 手机打不开页面?**
- 确认手机与电脑在同一局域网(同一路由器/WiFi);
- 确认 Windows 防火墙放行(首次启动桥接程序时选择"专用网络允许");
- 确认端口未被占用(换一个端口再启动);
- 电脑若是 AP 隔离的访客网络,设备间可能无法互访。

**Q: 电脑 IP 是多少?**
- 设置面板会显示可用地址;也可在 cmd 运行 `ipconfig`,查看 IPv4 地址。

**Q: 桥接程序启动失败?**
- 首次启动需在确认框选择「允许并记住」;
- 插件更新后(版本号变化)需要重新确认一次;
- 安全模式下插件进程能力不可用,退出安全模式再试。

**Q: 封面显示不出来?**
- 插件通过宿主渲染进程代理封面;网络封面加载失败时自动回退为主题色占位图;
- 本地文件歌曲的封面取决于 EchoMusic 提供的 coverUrl 是否可被渲染进程读取。

## 兼容性

- 要求 EchoMusic ≥ 2.2.7(`webServer` 与 `process` 能力);
- 桥接程序预编译 Windows x64 / Linux x64+arm64 / macOS x64+arm64。

## License

MIT

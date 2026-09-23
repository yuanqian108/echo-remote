// bridge.go —— EchoRemote 局域网桥接程序(Go 版,纯标准库)
//
// 监听 0.0.0.0:PORT,把 HTTP 请求反向代理到插件 webServer(127.0.0.1:PORT)。
// 与 bridge.zig(v1.4.1)行为对等,对插件 index.js 完全透明,可互换使用。
//
// 必须保持的外部契约(改动前先核对 index.js):
//   1. CLI:--listen <host:port>(默认 0.0.0.0:1987,纯数字视作端口)
//           --target <http://127.0.0.1:port>(必填,仅允许 http)
//   2. GET /__info 返回 {ok,version,listen,target,ip},带 CORS 头,本地响应不代理;
//   3. 启动时向 {target}/__bridge-report POST {ok,version,listen,target,ip,ips[]},
//      之后每 30s 上报一次(index.js:853 起消费,幂等);
//   4. 代理行为:hop-by-hop 头双向过滤、请求体 8MB 上限(413)、响应体 9MB 上限(502);
//   5. 二进制文件名按平台固定:bridge-x64.exe / bridge-x64 / bridge-arm64 /
//      bridge-macos-x64 / bridge-macos-arm64(index.js:85 按平台与顺序选择);
//   6. stdout/stderr 不被插件解析,SIGTERM 直接终止即可;
//   7. GET /ws(带 Upgrade 头)在本桥终结为 WebSocket,不再转发到插件(v1.6.0 起)。
//
// 与 Zig 版的有意差异(均为改进,不破坏契约):
//   - 并发:每个连接一个 goroutine(标准库默认),多台手机并发不再串行;
//   - 连接:上下游默认 keep-alive,轮询不再每次重建 TCP;
//   - 上报:固定 30s 定时器(Zig 版只在有请求进来时顺带补报,空闲时不上报);
//   - WebSocket:/ws 在本桥终结(纯标准库实现 RFC 6455),手机端用推送替代轮询;
//   - 体积:约 6-7MB/个(Zig 版约 2.4MB),静态编译无运行时依赖。
//
// 构建:CGO_ENABLED=0 go build -trimpath -ldflags "-s -w"
// 或直接运行 bridge-src/build-all.sh 交叉编译全部 5 个平台目标。

package main

import (
	"bufio"
	"bytes"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const version = "1.6.0-go"

const (
	maxRequestBody  = 8 << 20 // 与插件 webServer 单请求上限 8MB 对齐
	maxResponseBody = 9 << 20 // 插件 webServer 单响应上限 8MB,留 1MB 余量
	reportInterval  = 30 * time.Second
	upstreamTimeout = 20 * time.Second // 宿主自身 15s 会 504,桥给足余量让其透传
)

// ---- WebSocket 相关常量 ----
const (
	wsMaxMessage      = 64 << 10               // 单条 WS 消息上限(协议 JSON 远小于此)
	wsPingInterval    = 25 * time.Second       // 服务端心跳周期
	wsReadDeadline    = 60 * time.Second       // 读超时:期间收到任何帧(含 pong)都会重置
	wsSendQueue       = 32                     // 每连接发送缓冲,慢客户端丢帧由超时兜底
	maxUpstreamFetch  = 1 << 20                // 桥对插件的轮询/命令回包读取上限
	statePollInterval = 500 * time.Millisecond // state 推送节拍(对齐旧前端轮询频率)
	metaPollInterval  = 2 * time.Second        // queue/lyric meta 推送节拍
)

// hop-by-hop 头:逐跳消费,不参与转发(与 Zig 版 isHopByHop 清单一致)。
// 注意 upgrade 在列 —— 代理路径不透传升级请求;WS 在本桥 /ws 终结,与插件无关。
var hopByHopHeaders = map[string]bool{
	"connection":        true,
	"keep-alive":        true,
	"proxy-connection":  true,
	"transfer-encoding": true,
	"upgrade":           true,
	"te":                true,
	"trailer":           true,
	"host":              true,
	"content-length":    true, // 长度由双方各自按实际体长重写
}

var (
	listenAddr = "0.0.0.0:1987"
	target     = ""
)

func usage() {
	fmt.Fprintf(os.Stderr, `EchoRemote LAN bridge v%s (Go)

用法: bridge --listen <host:port> --target <http://127.0.0.1:port>
  例如: bridge --listen 0.0.0.0:1987 --target http://127.0.0.1:52133

  --listen   局域网监听地址(默认 0.0.0.0:1987)
  --target   插件 webServer 地址(必填,仅允许 http)
  --help     显示帮助
`, version)
}

// 通过 UDP connect + LocalAddr 探测本机主局域网 IPv4。
// UDP connect 是本地路由表操作,不实际发包(与 Zig 版 detectLocalIp 一致)。
func detectLocalIP() net.IP {
	conn, err := net.DialTimeout("udp", "8.8.8.8:53", 2*time.Second)
	if err != nil {
		return nil
	}
	defer conn.Close()
	addr, ok := conn.LocalAddr().(*net.UDPAddr)
	if !ok {
		return nil
	}
	return addr.IP.To4()
}

// /__info 响应与 /__bridge-report 上报体共用一个结构。
// 字段顺序与 Zig 版输出保持一致,便于对照排查;ip 为 nil 时序列化为 null。
type bridgeInfo struct {
	OK      bool      `json:"ok"`
	Version string    `json:"version"`
	Listen  string    `json:"listen"`
	Target  string    `json:"target"`
	IP      *string   `json:"ip"`
	IPs     []*string `json:"ips,omitempty"` // 仅上报体携带,单元素数组(可为 [null])
}

// 序列化时关闭 HTML 转义:Zig 版的 jsonEscape 不转义 <>&,
// 目标 URL 里若带查询参数,& 会被 Go 默认转成 \u0026,虽不影响解析但对照日志时碍眼。
func marshalJSON(v any) []byte {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(v)
	return bytes.TrimRight(buf.Bytes(), "\n")
}

func respondSimple(w http.ResponseWriter, status int, body string) {
	w.Header().Set("content-type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

func handleInfo(w http.ResponseWriter) {
	var ipPtr *string
	if ip := detectLocalIP(); ip != nil {
		s := ip.String()
		ipPtr = &s
	}
	body := marshalJSON(bridgeInfo{
		OK:      true,
		Version: version,
		Listen:  listenAddr,
		Target:  target,
		IP:      ipPtr,
	})
	w.Header().Set("content-type", "application/json; charset=utf-8")
	w.Header().Set("access-control-allow-origin", "*")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(body)
}

func copyHeaders(dst, src http.Header) {
	for name, values := range src {
		if hopByHopHeaders[strings.ToLower(name)] {
			continue
		}
		for _, v := range values {
			dst.Add(name, v)
		}
	}
}

func proxyRequest(client *http.Client, w http.ResponseWriter, r *http.Request) {
	// 1. 读取客户端请求体(仅这三个方法可能带体,其余忽略,与 Zig 版一致)
	var body []byte
	switch r.Method {
	case http.MethodPost, http.MethodPut, http.MethodPatch:
		b, err := io.ReadAll(io.LimitReader(r.Body, maxRequestBody+1))
		if err != nil {
			respondSimple(w, http.StatusBadGateway, "502 Bad Gateway")
			return
		}
		if len(b) > maxRequestBody {
			respondSimple(w, http.StatusRequestEntityTooLarge, "payload too large")
			return
		}
		body = b
	}

	// 2. 拼接目标 URL 并校验(只允许 http)
	joined := target + r.RequestURI
	if upURL, err := url.Parse(joined); err != nil || upURL.Scheme != "http" {
		respondSimple(w, http.StatusBadGateway, "target must be http://")
		return
	}

	// 3. 构造上游请求,转发原始头(去掉 hop-by-hop)
	upReq, err := http.NewRequest(r.Method, joined, bytes.NewReader(body))
	if err != nil {
		respondSimple(w, http.StatusBadGateway, "502 Bad Gateway")
		return
	}
	if len(body) == 0 {
		upReq.Body = nil // 无体时不发 Content-Length,贴近 Zig 版
	}
	copyHeaders(upReq.Header, r.Header)

	// 4. 发起代理请求
	resp, err := client.Do(upReq)
	if err != nil {
		respondSimple(w, http.StatusBadGateway, "502 Bad Gateway")
		log.Printf("[bridge] 请求处理失败: %v", err)
		return
	}
	defer resp.Body.Close()

	// 5. 整读响应体,超限 502(与 Zig 版一致:先读全量再回写,不做流式)
	resBody, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBody+1))
	if err != nil {
		respondSimple(w, http.StatusBadGateway, "502 Bad Gateway")
		return
	}
	if len(resBody) > maxResponseBody {
		respondSimple(w, http.StatusBadGateway, "response too large")
		return
	}

	// 6. 回写:响应头去 hop-by-hop;Content-Length 由标准库按实际体长写
	copyHeaders(w.Header(), resp.Header)
	w.WriteHeader(resp.StatusCode)
	_, _ = w.Write(resBody)
}

// 向插件上报本机地址。失败静默(下次 ticker 再试),不打断主服务。
func reportToPlugin(client *http.Client) {
	var ipPtr *string
	if ip := detectLocalIP(); ip != nil {
		s := ip.String()
		ipPtr = &s
	}
	payload := marshalJSON(bridgeInfo{
		OK:      true,
		Version: version,
		Listen:  listenAddr,
		Target:  target,
		IP:      ipPtr,
		IPs:     []*string{ipPtr},
	})
	req, err := http.NewRequest(http.MethodPost, target+"/__bridge-report", bytes.NewReader(payload))
	if err != nil {
		return
	}
	req.Header.Set("content-type", "application/json; charset=utf-8")
	resp, err := client.Do(req)
	if err != nil {
		return
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
}

// ---------------- WebSocket(/ws 在本桥终结) ----------------
//
// 为什么不透传到插件:宿主 ctx.webServer 是「收全量请求体 → IPC → 一次性回全量
// 响应体」的模型(见 webServer.ts:sanitizeResponseHeaders 剥 connection/
// transfer-encoding、强制 content-length、15s 超时),升级头和长连接都无法表达。
// 所以 WS 在桥上终结:桥对手机是 WS 服务端,对插件仍是普通 HTTP 客户端。
//
// 协议(全部 JSON 文本帧):
//   手机 → 桥: {"t":"sub","topic":"queue"|"lyric"}     订阅/退订 meta 推送
//              {"t":"unsub","topic":...}
//              {"t":"cmd","id":N,"body":{...}}          插件命令转发(带 id 才有回执)
//   桥 → 手机: {"t":"state","data":{...}|null}          500ms 一轮,推给所有客户端;
//                                                        上游故障时 data 为 null(只推一次)
//              {"t":"queueMeta","data":{...}}            2s 一轮,只推给订阅者
//              {"t":"lyricMeta","data":{...}}            同上
//              {"t":"cmdres","id":N,"data":{...}}        命令回执(插件响应原文)
// 客户端连接/订阅时立即补推缓存值,命令落地后立即补拉一轮 state。

const (
	opContinuation = 0x0
	opText         = 0x1
	opClose        = 0x8
	opPing         = 0x9
	opPong         = 0xA
)

var (
	wsGUID        = []byte("258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
	errWSProtocol = errors.New("websocket protocol violation")
	errWSTooBig   = errors.New("websocket message too large")
	wsNullData    = []byte("null")
)

// ---- RFC 6455 帧编解码(纯标准库,服务端视角) ----

// 读一帧。客户端帧必须带掩码(RFC 6455 §5.1),控制帧必须 FIN 且负载 ≤125。
func wsReadFrame(r *bufio.Reader) (fin bool, opcode byte, data []byte, err error) {
	var hdr [2]byte
	if _, err = io.ReadFull(r, hdr[:]); err != nil {
		return
	}
	fin = hdr[0]&0x80 != 0
	if hdr[0]&0x70 != 0 { // RSV1-3 必须为 0:未协商任何扩展
		err = errWSProtocol
		return
	}
	opcode = hdr[0] & 0x0f
	if hdr[1]&0x80 == 0 {
		err = errWSProtocol
		return
	}
	length := uint64(hdr[1] & 0x7f)
	switch length {
	case 126:
		var ext [2]byte
		if _, err = io.ReadFull(r, ext[:]); err != nil {
			return
		}
		length = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err = io.ReadFull(r, ext[:]); err != nil {
			return
		}
		length = binary.BigEndian.Uint64(ext[:])
	}
	if opcode >= opClose {
		if !fin || length > 125 {
			err = errWSProtocol
			return
		}
	} else if length > wsMaxMessage {
		err = errWSTooBig
		return
	}
	var mask [4]byte
	if _, err = io.ReadFull(r, mask[:]); err != nil {
		return
	}
	data = make([]byte, length)
	if _, err = io.ReadFull(r, data); err != nil {
		return
	}
	for i := range data {
		data[i] ^= mask[i&3]
	}
	return
}

// 写一帧。服务端帧不带掩码;所有消息单帧发送(FIN 恒置位,不分片)。
func wsWriteFrame(w *bufio.Writer, opcode byte, data []byte) error {
	hdr := []byte{0x80 | opcode}
	n := len(data)
	switch {
	case n < 126:
		hdr = append(hdr, byte(n))
	case n <= 0xffff:
		hdr = append(hdr, 126, byte(n>>8), byte(n))
	default:
		var ext [8]byte
		binary.BigEndian.PutUint64(ext[:], uint64(n))
		hdr = append(hdr, 127)
		hdr = append(hdr, ext[:]...)
	}
	if _, err := w.Write(hdr); err != nil {
		return err
	}
	if n > 0 {
		if _, err := w.Write(data); err != nil {
			return err
		}
	}
	return w.Flush()
}

// 包装推送消息:{"t":"<type>","id":N(仅 cmdres),"data":<上游 JSON 原文>}
func wsWrap(t string, id int64, data []byte) []byte {
	buf := make([]byte, 0, len(data)+48)
	buf = append(buf, `{"t":`...)
	tb, _ := json.Marshal(t)
	buf = append(buf, tb...)
	if id != 0 {
		buf = append(buf, `,"id":`...)
		buf = strconv.AppendInt(buf, id, 10)
	}
	buf = append(buf, `,"data":`...)
	buf = append(buf, data...)
	buf = append(buf, '}')
	return buf
}

// ---- 连接 ----

type wsOut struct {
	op   byte
	data []byte
}

type wsClient struct {
	hub    *wsHub
	conn   net.Conn
	br     *bufio.Reader // Hijack 拿到的读端,可能已缓冲了握手后的首帧
	send   chan wsOut
	done   chan struct{}
	once   sync.Once
	topics map[string]bool
}

func (c *wsClient) enqueueText(msg []byte) { c.enqueue(opText, msg) }

// 非阻塞入队:慢客户端丢帧(读写超时会兜底断开),绝不反压轮询协程。
func (c *wsClient) enqueue(op byte, data []byte) {
	select {
	case <-c.done:
	case c.send <- wsOut{op, data}:
	default:
	}
}

func (c *wsClient) shutdown() {
	c.once.Do(func() {
		close(c.done)
		_ = c.conn.Close() // 解除 readLoop 的阻塞
	})
}

// 独立写协程:所有出站帧(含 ping/pong/close)都从这里走,天然免锁、不交错。
func (c *wsClient) writeLoop() {
	bw := bufio.NewWriterSize(c.conn, 8192)
	ticker := time.NewTicker(wsPingInterval)
	defer func() {
		ticker.Stop()
		c.hub.remove(c)
		_ = c.conn.Close()
	}()
	for {
		select {
		case <-c.done:
			_ = wsWriteFrame(bw, opClose, nil) // 尽力补一个 close 帧再走
			return
		case <-ticker.C:
			if err := wsWriteFrame(bw, opPing, nil); err != nil {
				return
			}
		case out := <-c.send:
			if err := wsWriteFrame(bw, out.op, out.data); err != nil {
				return
			}
		}
	}
}

func (c *wsClient) readLoop() {
	defer c.hub.remove(c)
	for {
		_ = c.conn.SetReadDeadline(time.Now().Add(wsReadDeadline))
		msg, err := c.readMessage()
		if err != nil {
			return
		}
		c.hub.handleClientMessage(c, msg)
	}
}

// 读取一条完整消息:拼接 continuation 帧;控制帧就地处理。
// 对端发 close 返回 io.EOF;协议违约/超限/IO 错误也一律断开。
func (c *wsClient) readMessage() ([]byte, error) {
	var msg []byte
	for {
		fin, op, payload, err := wsReadFrame(c.br)
		if err != nil {
			return nil, err
		}
		switch op {
		case opClose:
			return nil, io.EOF
		case opPing:
			c.enqueue(opPong, payload)
		case opPong:
			// 心跳回执;任何帧都会重置读超时,无需额外处理
		case opContinuation:
			if msg == nil {
				return nil, errWSProtocol
			}
			msg = append(msg, payload...)
			if len(msg) > wsMaxMessage {
				return nil, errWSTooBig
			}
			if fin {
				return msg, nil
			}
		case opText:
			if msg != nil {
				return nil, errWSProtocol
			}
			if fin {
				return payload, nil
			}
			msg = payload
		default: // 二进制帧等:本协议不用
			return nil, errWSProtocol
		}
	}
}

// ---- hub:连接表 + 订阅表 + 轮询器 ----

type wsHub struct {
	target string
	client *http.Client

	mu        sync.Mutex
	clients   map[*wsClient]bool
	queueSubs map[*wsClient]bool
	lyricSubs map[*wsClient]bool
	// 最近一轮上游响应原文(连接/订阅时立即补推,避免干等一个轮询周期)
	lastState     []byte
	lastQueueMeta []byte
	lastLyricMeta []byte
	stateErr      bool // 上游 state 当前是否故障(故障→恢复的边沿才推 null/数据)

	kickState chan struct{}
	kickQueue chan struct{}
	kickLyric chan struct{}
}

func newWSHub(target string, client *http.Client) *wsHub {
	return &wsHub{
		target:    target,
		client:    client,
		clients:   make(map[*wsClient]bool),
		queueSubs: make(map[*wsClient]bool),
		lyricSubs: make(map[*wsClient]bool),
		kickState: make(chan struct{}, 1),
		kickQueue: make(chan struct{}, 1),
		kickLyric: make(chan struct{}, 1),
	}
}

func (h *wsHub) kick(ch chan struct{}) {
	select {
	case ch <- struct{}{}:
	default:
	}
}

func (h *wsHub) run() {
	go h.pollLoop(statePollInterval, h.kickState, h.stateTick)
	go h.pollLoop(metaPollInterval, h.kickQueue, h.queueTick)
	go h.pollLoop(metaPollInterval, h.kickLyric, h.lyricTick)
}

// 轮询循环:tick 同步执行,上游挂了也只会「拖慢节拍」,不会堆叠并发请求。
// 没有受众(无客户端/无订阅者)时跳过上游请求,空闲零开销。
func (h *wsHub) pollLoop(every time.Duration, kick chan struct{}, tick func()) {
	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-t.C:
		case <-kick:
		}
		tick()
	}
}

func (h *wsHub) fetchUpstream(path string) ([]byte, error) {
	req, err := http.NewRequest(http.MethodGet, h.target+path, nil)
	if err != nil {
		return nil, err
	}
	resp, err := h.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxUpstreamFetch+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxUpstreamFetch || resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("上游 %s 响应异常(status=%d)", path, resp.StatusCode)
	}
	return body, nil
}

func (h *wsHub) stateTick() {
	h.mu.Lock()
	n := len(h.clients)
	h.mu.Unlock()
	if n == 0 {
		return
	}
	body, err := h.fetchUpstream("/api/state")
	h.mu.Lock()
	defer h.mu.Unlock()
	if err != nil || !json.Valid(body) {
		if !h.stateErr {
			h.stateErr = true
			h.broadcastLocked(wsWrap("state", 0, wsNullData))
		}
		return
	}
	h.stateErr = false
	h.lastState = body
	h.broadcastLocked(wsWrap("state", 0, body))
}

func (h *wsHub) metaTick(subs map[*wsClient]bool, path string, name string, cache *[]byte) {
	h.mu.Lock()
	n := len(subs)
	h.mu.Unlock()
	if n == 0 {
		return
	}
	body, err := h.fetchUpstream(path)
	if err != nil || !json.Valid(body) {
		return // meta 尽力而为:上游故障静默跳过,离线信号由 state 的 null 承担
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	*cache = body
	h.broadcastSubsLocked(subs, wsWrap(name, 0, body))
}

func (h *wsHub) queueTick() {
	h.metaTick(h.queueSubs, "/api/queue?meta=1", "queueMeta", &h.lastQueueMeta)
}

func (h *wsHub) lyricTick() {
	h.metaTick(h.lyricSubs, "/api/lyric?meta=1", "lyricMeta", &h.lastLyricMeta)
}

// 调用方需持有 h.mu
func (h *wsHub) broadcastLocked(msg []byte) {
	for c := range h.clients {
		c.enqueueText(msg)
	}
}

// 调用方需持有 h.mu
func (h *wsHub) broadcastSubsLocked(subs map[*wsClient]bool, msg []byte) {
	for c := range h.clients {
		if subs[c] {
			c.enqueueText(msg)
		}
	}
}

func (h *wsHub) register(c *wsClient) {
	h.mu.Lock()
	h.clients[c] = true
	cached := h.lastState
	stateErr := h.stateErr
	h.mu.Unlock()
	if stateErr {
		c.enqueueText(wsWrap("state", 0, wsNullData))
	} else if cached != nil {
		c.enqueueText(wsWrap("state", 0, cached))
	}
	h.kick(h.kickState) // 立即拉一轮最新(缓存可能是无客户端期间落下的旧值)
}

func (h *wsHub) remove(c *wsClient) {
	h.mu.Lock()
	if h.clients[c] {
		delete(h.clients, c)
		if c.topics["queue"] {
			delete(h.queueSubs, c)
		}
		if c.topics["lyric"] {
			delete(h.lyricSubs, c)
		}
	}
	h.mu.Unlock()
	c.shutdown()
}

func (h *wsHub) subscribe(c *wsClient, topic string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	var cached []byte
	var kick chan struct{}
	var name string
	switch topic {
	case "queue":
		if !h.queueSubs[c] {
			h.queueSubs[c] = true
			c.topics[topic] = true
		}
		cached, kick, name = h.lastQueueMeta, h.kickQueue, "queueMeta"
	case "lyric":
		if !h.lyricSubs[c] {
			h.lyricSubs[c] = true
			c.topics[topic] = true
		}
		cached, kick, name = h.lastLyricMeta, h.kickLyric, "lyricMeta"
	default:
		return
	}
	if cached != nil {
		c.enqueueText(wsWrap(name, 0, cached))
	}
	h.kick(kick)
}

func (h *wsHub) unsubscribe(c *wsClient, topic string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	switch topic {
	case "queue":
		delete(h.queueSubs, c)
		delete(c.topics, "queue")
	case "lyric":
		delete(h.lyricSubs, c)
		delete(c.topics, "lyric")
	}
}

type wsInMsg struct {
	T     string          `json:"t"`
	Topic string          `json:"topic"`
	ID    int64           `json:"id"`
	Body  json.RawMessage `json:"body"`
}

func (h *wsHub) handleClientMessage(c *wsClient, data []byte) {
	var m wsInMsg
	if err := json.Unmarshal(data, &m); err != nil || m.T == "" {
		return // 无法识别的消息直接忽略,不断连接
	}
	switch m.T {
	case "sub":
		h.subscribe(c, m.Topic)
	case "unsub":
		h.unsubscribe(c, m.Topic)
	case "cmd":
		go h.handleCmd(c, m.ID, m.Body) // 独立协程:上游慢不阻塞该连接后续消息
	}
}

// 命令转发:WS → 插件 /api/command(HTTP POST),插件响应原文按 id 包成 cmdres。
func (h *wsHub) handleCmd(c *wsClient, id int64, body json.RawMessage) {
	payload := []byte(body)
	if len(payload) == 0 || string(payload) == "null" {
		payload = []byte("{}")
	}
	var data []byte
	if req, err := http.NewRequest(http.MethodPost, h.target+"/api/command", bytes.NewReader(payload)); err == nil {
		req.Header.Set("content-type", "application/json; charset=utf-8")
		if resp, err2 := h.client.Do(req); err2 == nil {
			b, _ := io.ReadAll(io.LimitReader(resp.Body, maxUpstreamFetch+1))
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK && len(b) <= maxUpstreamFetch && json.Valid(b) {
				data = b
			}
		}
	}
	if data == nil {
		data = []byte(`{"ok":false,"error":"桥到插件的命令请求失败"}`)
	}
	h.kick(h.kickState) // 命令落地后立刻补一轮 state 推送
	if id != 0 {
		c.enqueueText(wsWrap("cmdres", id, data))
	}
}

// ---- 握手入口 ----

func (h *wsHub) handleWS(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet ||
		!strings.EqualFold(r.Header.Get("Upgrade"), "websocket") ||
		!strings.Contains(strings.ToLower(r.Header.Get("Connection")), "upgrade") ||
		r.Header.Get("Sec-WebSocket-Key") == "" ||
		r.Header.Get("Sec-WebSocket-Version") != "13" {
		respondSimple(w, http.StatusBadRequest, "expected websocket upgrade")
		return
	}
	hj, ok := w.(http.Hijacker)
	if !ok {
		respondSimple(w, http.StatusInternalServerError, "hijack unsupported")
		return
	}
	conn, brw, err := hj.Hijack()
	if err != nil {
		return
	}
	// RFC 6455 §4.2.2:Accept = base64(sha1(key + 魔数))
	sum := sha1.Sum(append([]byte(r.Header.Get("Sec-WebSocket-Key")), wsGUID...))
	accept := base64.StdEncoding.EncodeToString(sum[:])
	resp := "HTTP/1.1 101 Switching Protocols\r\n" +
		"Upgrade: websocket\r\n" +
		"Connection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + accept + "\r\n\r\n"
	if _, err := brw.Writer.WriteString(resp); err != nil {
		_ = conn.Close()
		return
	}
	if err := brw.Writer.Flush(); err != nil {
		_ = conn.Close()
		return
	}
	c := &wsClient{
		hub:    h,
		conn:   conn,
		br:     brw.Reader,
		send:   make(chan wsOut, wsSendQueue),
		done:   make(chan struct{}),
		topics: make(map[string]bool),
	}
	h.register(c)
	go c.writeLoop()
	c.readLoop() // 就地占用当前 handler 协程读,断开即返回
}

func main() {
	flag.StringVar(&listenAddr, "listen", "0.0.0.0:1987", "局域网监听地址(默认 0.0.0.0:1987)")
	flag.StringVar(&target, "target", "", "插件 webServer 地址(必填,仅允许 http)")
	flag.Usage = usage
	flag.Parse()

	if target == "" {
		usage()
		os.Exit(2)
	}

	// --listen 允许只写端口号(与 Zig 版 parseListen 一致:纯数字视作 0.0.0.0:port)
	if !strings.Contains(listenAddr, ":") {
		listenAddr = "0.0.0.0:" + listenAddr
	}

	ln, err := net.Listen("tcp", listenAddr)
	if err != nil {
		log.Fatalf("[bridge] 监听失败: %v", err)
	}

	// 上游固定是本机回环,必须显式禁用环境代理:
	// 若机器配了 HTTP_PROXY 且未设 NO_PROXY,默认 Transport 会把 127.0.0.1 的
	// 请求也发给代理,桥就废了。Zig 版天然不读环境代理,这里要显式对齐。
	transport := &http.Transport{
		Proxy:               nil,
		DisableCompression:  true, // 不主动协商 gzip,透传插件原始响应(与 Zig 版一致)
		MaxIdleConns:        16,
		MaxIdleConnsPerHost: 8,
		IdleConnTimeout:     60 * time.Second,
	}
	client := &http.Client{
		Transport: transport,
		Timeout:   upstreamTimeout,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/__info", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			handleInfo(w)
			return
		}
		// 非 GET 的 /__info 不本地响应,走代理(与 Zig 版一致)
		proxyRequest(client, w, r)
	})
	hub := newWSHub(target, client)
	mux.HandleFunc("/ws", hub.handleWS)
	go hub.run()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		proxyRequest(client, w, r)
	})

	srv := &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       75 * time.Second,
	}

	// 启动即上报,之后每 30s 一次(Zig 版是"有请求时顺带补报",定时更可靠;
	// 插件侧 applyBridgeInfo 幂等,只更新地址列表)
	reportToPlugin(client)
	go func() {
		ticker := time.NewTicker(reportInterval)
		for range ticker.C {
			reportToPlugin(client)
		}
	}()

	log.Printf("[bridge] %s -> %s", listenAddr, target)
	if err := srv.Serve(ln); err != nil && err != http.ErrServerClosed {
		log.Fatalf("[bridge] 服务异常退出: %v", err)
	}
}

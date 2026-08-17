// bridge.zig —— EchoRemote 局域网桥接程序(Zig 0.14.1)
// 监听 0.0.0.0:PORT,把 HTTP 请求反向代理到插件 webServer(127.0.0.1:PORT)。
// 纯 Zig 标准库,无外部依赖。构建: zig build-exe bridge.zig -O ReleaseSmall

const std = @import("std");

const VERSION = "1.4.1";
const DEFAULT_LISTEN_HOST = "0.0.0.0";
const DEFAULT_LISTEN_PORT: u16 = 1987;
const MAX_REQUEST_BODY: usize = 8 * 1024 * 1024;
const MAX_RESPONSE_BODY: usize = 9 * 1024 * 1024; // 插件 webServer 单响应上限 8MB
const READ_BUFFER_SIZE: usize = 16 * 1024;
const SERVER_HEADER_BUFFER_SIZE: usize = 16 * 1024;
const MAX_RELAY_HEADERS: usize = 25; // Response.respond 的 extra_headers 上限

var listen_host: []const u8 = DEFAULT_LISTEN_HOST;
var listen_port: u16 = DEFAULT_LISTEN_PORT;
var target: []const u8 = "";

fn usage() void {
    std.debug.print(
        \\EchoRemote LAN bridge v{s}
        \\
        \\用法: bridge --listen <host:port> --target <http://127.0.0.1:port>
        \\  例如: bridge --listen 0.0.0.0:1987 --target http://127.0.0.1:52133
        \\
        \\  --listen   局域网监听地址(默认 0.0.0.0:1987)
        \\  --target   插件 webServer 地址(必填,仅允许 http)
        \\  --help     显示帮助
        \\
    , .{VERSION});
}

fn parseListen(value: []const u8) !void {
    if (std.mem.indexOfScalar(u8, value, ':')) |colon| {
        listen_host = value[0..colon];
        listen_port = try std.fmt.parseInt(u16, value[colon + 1 ..], 10);
    } else {
        listen_port = try std.fmt.parseInt(u16, value, 10);
    }
}

fn isHopByHop(name: []const u8) bool {
    return std.ascii.eqlIgnoreCase(name, "connection") or
        std.ascii.eqlIgnoreCase(name, "keep-alive") or
        std.ascii.eqlIgnoreCase(name, "proxy-connection") or
        std.ascii.eqlIgnoreCase(name, "transfer-encoding") or
        std.ascii.eqlIgnoreCase(name, "upgrade") or
        std.ascii.eqlIgnoreCase(name, "te") or
        std.ascii.eqlIgnoreCase(name, "trailer") or
        std.ascii.eqlIgnoreCase(name, "host") or
        std.ascii.eqlIgnoreCase(name, "content-length");
}

/// 通过 UDP connect + getsockname 探测本机主局域网 IPv4(不实际发包)。
fn detectLocalIp() ?[4]u8 {
    const sock = std.posix.socket(std.posix.AF.INET, std.posix.SOCK.DGRAM | std.posix.SOCK.CLOEXEC, 0) catch return null;
    defer std.posix.close(sock);
    const target_addr = std.net.Address.initIp4(.{ 8, 8, 8, 8 }, 53);
    std.posix.connect(sock, &target_addr.any, target_addr.getOsSockLen()) catch return null;
    var local: std.posix.sockaddr.storage = undefined;
    var len: std.posix.socklen_t = @sizeOf(std.posix.sockaddr.storage);
    std.posix.getsockname(sock, @ptrCast(&local), &len) catch return null;
    const in: *const std.posix.sockaddr.in = @alignCast(@ptrCast(&local));
    // sockaddr_in 在内存中按网络字节序存放,小端机器上直接按字节读出即得到点分顺序
    const bytes: *const [4]u8 = @ptrCast(&in.addr);
    return .{ bytes[0], bytes[1], bytes[2], bytes[3] };
}

fn jsonEscape(allocator: std.mem.Allocator, value: []const u8) ![]u8 {
    var out = std.ArrayList(u8).init(allocator);
    for (value) |ch| {
        switch (ch) {
            '"' => try out.appendSlice("\\\""),
            '\\' => try out.appendSlice("\\\\"),
            0...8, 11, 12, 14...31 => try out.writer().print("\\u{x:0>4}", .{ch}),
            else => try out.append(ch),
        }
    }
    return out.toOwnedSlice();
}

fn respondSimple(request: *std.http.Server.Request, status: std.http.Status, body: []const u8) !void {
    try request.respond(body, .{
        .status = status,
        .keep_alive = false,
    });
}

fn respondInfo(allocator: std.mem.Allocator, request: *std.http.Server.Request) !void {
    const ip = detectLocalIp();
    const ip_json = if (ip) |a|
        try std.fmt.allocPrint(allocator, "\"{d}.{d}.{d}.{d}\"", .{ a[0], a[1], a[2], a[3] })
    else
        try allocator.dupe(u8, "null");
    defer allocator.free(ip_json);
    const target_json = try jsonEscape(allocator, target);
    defer allocator.free(target_json);
    const body = try std.fmt.allocPrint(allocator,
        "{{\"ok\":true,\"version\":\"{s}\",\"listen\":\"{s}:{d}\",\"target\":\"{s}\",\"ip\":{s}}}",
        .{ VERSION, listen_host, listen_port, target_json, ip_json },
    );
    defer allocator.free(body);
    var headers: [2]std.http.Header = .{
        .{ .name = "content-type", .value = "application/json; charset=utf-8" },
        .{ .name = "access-control-allow-origin", .value = "*" },
    };
    try request.respond(body, .{
        .status = .ok,
        .extra_headers = &headers,
        .keep_alive = false,
    });
}

/// 启动后主动把本机局域网地址上报给插件 webServer(不依赖插件反向轮询)。
fn reportToPlugin(allocator: std.mem.Allocator) void {
    const ip = detectLocalIp();
    const ip_json = if (ip) |a|
        std.fmt.allocPrint(allocator, "\"{d}.{d}.{d}.{d}\"", .{ a[0], a[1], a[2], a[3] }) catch return
    else
        allocator.dupe(u8, "null") catch return;
    defer allocator.free(ip_json);
    const target_json = jsonEscape(allocator, target) catch return;
    defer allocator.free(target_json);
    const body = std.fmt.allocPrint(allocator,
        "{{\"ok\":true,\"version\":\"{s}\",\"listen\":\"{s}:{d}\",\"target\":\"{s}\",\"ip\":{s},\"ips\":[{s}]}}",
        .{ VERSION, listen_host, listen_port, target_json, ip_json, ip_json },
    ) catch return;
    defer allocator.free(body);

    const url = std.fmt.allocPrint(allocator, "{s}/__bridge-report", .{target}) catch return;
    defer allocator.free(url);
    const uri = std.Uri.parse(url) catch return;

    var client: std.http.Client = .{ .allocator = allocator };
    defer client.deinit();
    var server_header_buffer: [SERVER_HEADER_BUFFER_SIZE]u8 = undefined;
    var creq = client.open(.POST, uri, .{
        .server_header_buffer = &server_header_buffer,
        .keep_alive = false,
        .redirect_behavior = .not_allowed,
    }) catch return;
    defer creq.deinit();
    creq.transfer_encoding = .{ .content_length = body.len };
    creq.send() catch return;
    creq.writeAll(body) catch return;
    creq.finish() catch return;
    creq.wait() catch return;
}

fn proxyRequest(allocator: std.mem.Allocator, request: *std.http.Server.Request) !void {
    const method = request.head.method;
    const path = request.head.target;

    // 1. 读取客户端请求体
    var body: []u8 = &.{};
    if (method == .POST or method == .PUT or method == .PATCH) {
        var body_reader = try request.reader();
        body = try body_reader.readAllAlloc(allocator, MAX_REQUEST_BODY + 1);
        if (body.len > MAX_REQUEST_BODY) {
            try respondSimple(request, .payload_too_large, "payload too large");
            return;
        }
    }
    defer if (body.len > 0) allocator.free(body);

    // 2. 拼接目标 URL
    const joined = try std.fmt.allocPrint(allocator, "{s}{s}", .{ target, path });
    defer allocator.free(joined);
    const uri = try std.Uri.parse(joined);
    if (!std.mem.eql(u8, uri.scheme, "http")) return error.InvalidTargetScheme;

    // 3. 转发请求头(去掉 hop-by-hop)
    var extra = std.ArrayList(std.http.Header).init(allocator);
    defer extra.deinit();
    var hit = request.iterateHeaders();
    while (hit.next()) |h| {
        if (isHopByHop(h.name)) continue;
        try extra.append(.{ .name = h.name, .value = h.value });
    }

    // 4. 发起代理请求
    var client: std.http.Client = .{ .allocator = allocator };
    defer client.deinit();
    var server_header_buffer: [SERVER_HEADER_BUFFER_SIZE]u8 = undefined;
    var creq = try client.open(method, uri, .{
        .server_header_buffer = &server_header_buffer,
        .keep_alive = false,
        .redirect_behavior = .not_allowed,
        .extra_headers = extra.items,
    });
    defer creq.deinit();
    creq.transfer_encoding = if (body.len > 0) .{ .content_length = body.len } else .none;
    try creq.send();
    try creq.writeAll(body);
    try creq.finish();
    try creq.wait();

    // 5. 转存响应头
    var relayed: [MAX_RELAY_HEADERS]std.http.Header = undefined;
    var relayed_len: usize = 0;
    var rit = creq.response.iterateHeaders();
    while (rit.next()) |h| {
        if (isHopByHop(h.name)) continue;
        if (relayed_len >= MAX_RELAY_HEADERS) continue;
        relayed[relayed_len] = .{ .name = h.name, .value = h.value };
        relayed_len += 1;
    }

    // 6. 读取响应体并回写
    const res_body = try creq.reader().readAllAlloc(allocator, MAX_RESPONSE_BODY + 1);
    defer allocator.free(res_body);
    if (res_body.len > MAX_RESPONSE_BODY) {
        try respondSimple(request, .bad_gateway, "response too large");
        return;
    }
    try request.respond(res_body, .{
        .status = creq.response.status,
        .extra_headers = relayed[0..relayed_len],
        .keep_alive = false,
    });
}

fn handleConnection(allocator: std.mem.Allocator, request: *std.http.Server.Request) void {
    proxyRequest(allocator, request) catch |err| {
        if (err == error.InvalidTargetScheme) {
            respondSimple(request, .bad_gateway, "target must be http://") catch {};
            return;
        }
        respondSimple(request, .bad_gateway, "502 Bad Gateway") catch {};
        std.debug.print("[bridge] 请求处理失败: {s}\n", .{@errorName(err)});
    };
}

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    const args = try std.process.argsAlloc(allocator);
    defer std.process.argsFree(allocator, args);

    var i: usize = 1;
    while (i < args.len) : (i += 1) {
        const arg = args[i];
        if (std.mem.eql(u8, arg, "--listen")) {
            i += 1;
            if (i >= args.len) {
                usage();
                return error.MissingArg;
            }
            try parseListen(args[i]);
        } else if (std.mem.eql(u8, arg, "--target")) {
            i += 1;
            if (i >= args.len) {
                usage();
                return error.MissingArg;
            }
            target = args[i];
        } else if (std.mem.eql(u8, arg, "--help") or std.mem.eql(u8, arg, "-h")) {
            usage();
            return;
        } else {
            usage();
            return error.UnknownArg;
        }
    }
    if (target.len == 0) {
        usage();
        return error.MissingTarget;
    }

    const address = try std.net.Address.parseIp(listen_host, listen_port);
    var net_server = try address.listen(.{ .reuse_address = true, .kernel_backlog = 128 });
    defer net_server.deinit();
    std.debug.print("[bridge] {s}:{d} -> {s}\n", .{ listen_host, listen_port, target });

    var last_report_ms: i64 = 0;
    reportToPlugin(allocator);
    last_report_ms = std.time.milliTimestamp();

    while (true) {
        const conn = try net_server.accept();
        defer conn.stream.close();

        var read_buffer: [READ_BUFFER_SIZE]u8 = undefined;
        var server = std.http.Server.init(conn, &read_buffer);
        var request = server.receiveHead() catch {
            continue; // 头部解析失败/客户端断开
        };

        if (request.head.method == .GET and std.mem.eql(u8, request.head.target, "/__info")) {
            respondInfo(allocator, &request) catch |err| {
                std.debug.print("[bridge] __info 失败: {s}\n", .{@errorName(err)});
            };
        } else {
            handleConnection(allocator, &request);
        }

        const now_ms = std.time.milliTimestamp();
        if (now_ms - last_report_ms > 30_000) {
            reportToPlugin(allocator);
            last_report_ms = now_ms;
        }
    }
}

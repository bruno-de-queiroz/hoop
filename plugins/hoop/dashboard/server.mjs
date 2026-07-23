// Front process for the dashboard container.
//
// Why this exists: the browser↔dashboard live channel was Server-Sent Events
// (`/api/stream`). SSE works locally, but Cloudflare quick tunnels (and other
// buffering proxies) buffer the entire `text/event-stream` response and never
// flush it, so a remote co-driving peer never receives live events. WebSockets
// are an upgrade protocol, not a buffered HTTP response, and pass through CF
// tunnels unbuffered — so the live channel is now a WebSocket at `/api/ws`.
//
// Next.js standalone doesn't let us attach an HTTP `upgrade` handler to its
// server, so this thin front process:
//   1. spawns the UNCHANGED Next standalone server on an internal port,
//   2. transparently reverse-proxies all HTTP to it (Next still runs every
//      middleware/route/auth check exactly as before — this process adds no
//      HTTP auth of its own),
//   3. serves the one thing Next can't: the `/api/ws` upgrade. The WS bridge
//      consumes Next's own `/api/stream` over localhost (where SSE streams
//      fine) and re-broadcasts each frame to WebSocket clients, scoped so a
//      peer only receives events for the session they were shared into.
//
// Net: zero changes to the Next app; the buffering-proxy problem is solved at
// the transport layer.

import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { connect as netConnect } from "node:net";
import { createHmac, timingSafeEqual } from "node:crypto";
import { request as udsRequest } from "node:http";
import { readFileSync } from "node:fs";
import { WebSocketServer } from "ws";

// Dev mode (HMR): when the CLI's HOOP_DASHBOARD_DEV override is active, run the
// full `next dev` server on the internal port instead of the baked standalone
// `server.js`, and proxy Next's own HMR websocket (/_next/webpack-hmr) through
// this front process. Off by default → the prod path is byte-identical.
const DEV = /^(1|true|yes|on)$/i.test(process.env.HOOP_DASHBOARD_DEV ?? "");

const PUBLIC_PORT = parseInt(process.env.HOOP_PORT ?? "", 10) || 7842;
const PUBLIC_HOST = process.env.HOSTNAME || "0.0.0.0";
const INTERNAL_PORT = PUBLIC_PORT + 1; // Next standalone, loopback only
const INTERNAL_HOST = "127.0.0.1";

const DASHBOARD_TOKEN = process.env.HOOP_DASHBOARD_TOKEN ?? "";
const PEER_SECRET = process.env.HOOP_PEER_SIGNING_SECRET ?? "";
const PEER_COOKIE = "hoop_peer";
const INSTALL_COOKIE = "hoop_token";

// Sandbox UDS — used to check share revocation for the live (WS) channel, so a
// revoked peer's feed is cut, not just their writes.
const SANDBOX_SOCKET = process.env.HOOP_SANDBOX_SOCKET || "/var/run/hoop/sandbox.sock";
const SANDBOX_TOKEN_FILE = process.env.HOOP_SANDBOX_TOKEN_FILE || "/var/run/hoop/sandbox.token";
const SANDBOX_TOKEN_HEADER = "x-sandbox-token";

const log = (...a) => console.log("[front]", ...a);

// Is a share still live? The sandbox is the authority: GET /shares/:id returns
// 200 for a live grant, 404 once revoked/expired. Fail-open on transient
// errors (local UDS blip shouldn't drop an active pairing — the next check
// retries, and peer READ paths are guarded independently). Only an explicit
// 404 means "revoked".
function shareLive(shareId) {
  return new Promise((resolve) => {
    let token = "";
    try { token = readFileSync(SANDBOX_TOKEN_FILE, "utf-8").trim(); } catch { /* ignore */ }
    if (!token || !shareId) return resolve(true); // can't check → don't over-drop
    const r = udsRequest(
      { socketPath: SANDBOX_SOCKET, method: "GET", path: `/shares/${encodeURIComponent(shareId)}`,
        headers: { [SANDBOX_TOKEN_HEADER]: token }, timeout: 3000 },
      (res) => { res.resume(); resolve(res.statusCode !== 404); },
    );
    r.on("error", () => resolve(true));
    r.on("timeout", () => { r.destroy(); resolve(true); });
    r.end();
  });
}

// Revoke every share in the sandbox. Called whenever the tunnel goes away
// (stop, host DELETE, or cloudflared dying): each share is bound to the tunnel
// hostname that just disappeared, so the grants are now dangling and must be
// cleared — otherwise the peer read guard (which checks shareId only, not host)
// would keep an already-connected peer alive against a dead tunnel. Fire-and-
// forget + short timeout so it never blocks tunnel teardown or shutdown.
function revokeAllSharesInSandbox() {
  return new Promise((resolve) => {
    let token = "";
    try { token = readFileSync(SANDBOX_TOKEN_FILE, "utf-8").trim(); } catch { /* ignore */ }
    if (!token) return resolve();
    const r = udsRequest(
      { socketPath: SANDBOX_SOCKET, method: "POST", path: "/shares/revoke-all",
        headers: { [SANDBOX_TOKEN_HEADER]: token, "content-length": 0 }, timeout: 3000 },
      (res) => { res.resume(); res.on("end", resolve); },
    );
    r.on("error", () => resolve());
    r.on("timeout", () => { r.destroy(); resolve(); });
    r.end();
  });
}

// ── 1. Spawn the Next server on the internal port ────────────────────────────
// Prod: the traced standalone `server.js`. Dev: `next dev` (webpack HMR) from
// the bind-mounted source, so edits are live without an image rebuild.
const next = DEV
  ? spawn(
      "./node_modules/.bin/next",
      ["dev", "--webpack", "-p", String(INTERNAL_PORT), "-H", INTERNAL_HOST],
      { env: { ...process.env }, stdio: "inherit" },
    )
  : spawn("node", ["server.js"], {
      env: { ...process.env, PORT: String(INTERNAL_PORT), HOSTNAME: INTERNAL_HOST },
      stdio: "inherit",
    });
if (DEV) log(`dev mode: next dev (webpack HMR) on ${INTERNAL_HOST}:${INTERNAL_PORT}`);
next.on("exit", (code) => { log("next exited", code); process.exit(code ?? 1); });
process.on("SIGTERM", () => next.kill("SIGTERM"));
process.on("SIGINT", () => next.kill("SIGINT"));

// ── auth helpers (mirror lib/peer-token.ts + lib/auth-edge.ts) ───────────────
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
function ctEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  try { return timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
}
function b64urlFromBuf(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function normHost(h) {
  if (!h) return "";
  let s = h.trim().toLowerCase();
  if (s.startsWith("[")) { const e = s.indexOf("]"); return e >= 0 ? s.slice(0, e + 1) : s; }
  const c = s.indexOf(":");
  return c >= 0 ? s.slice(0, c) : s;
}
// Verify a dashboard-signed peer token: base64url(payload).base64url(hmacSHA256(payload)).
function verifyPeerToken(token) {
  if (!token || !PEER_SECRET) return null;
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  const expected = b64urlFromBuf(createHmac("sha256", PEER_SECRET).update(payloadB64).digest());
  if (!ctEq(sigB64, expected)) return null;
  let payload;
  try {
    const json = Buffer.from(payloadB64.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
    payload = JSON.parse(json);
  } catch { return null; }
  if (payload.exp && Date.now() > payload.exp) return null;
  return payload;
}
// Resolve the participant for a WS upgrade. Returns {kind:"host"} |
// {kind:"peer", ses, allowed:Set} | null. Same-origin enforced (the cookies are
// SameSite=Strict, so a cross-site WS wouldn't carry them anyway).
function authUpgrade(req) {
  const host = normHost(req.headers.host);
  const origin = req.headers.origin;
  if (origin) {
    try { if (normHost(new URL(origin).host) !== host) return null; } catch { return null; }
  }
  const cookies = parseCookies(req.headers.cookie);
  if (DASHBOARD_TOKEN && ctEq(cookies[INSTALL_COOKIE] ?? "", DASHBOARD_TOKEN)) {
    return { kind: "host" };
  }
  const peerTok = cookies[PEER_COOKIE];
  if (peerTok) {
    const p = verifyPeerToken(peerTok);
    if (p && p.host === host && p.ses) {
      return { kind: "peer", ses: p.ses, sid: p.sid, allowed: new Set([p.ses]) };
    }
  }
  return null;
}

// ── managed cloudflare tunnel (host-controlled, on-demand) ──────────────────
// The host exposes the dashboard for peer co-drive without installing anything:
// this process spawns `cloudflared` (bundled in the image) as a quick tunnel to
// its own public port, parses the assigned *.trycloudflare.com hostname from
// cloudflared's output, and hands it to the dashboard so a share can be bound
// to it. On-demand only — nothing is exposed until the host starts it.
const tunnel = {
  proc: null,
  url: null,
  status: "stopped", // "stopped" | "starting" | "running" | "error"
  error: null,
  waiters: [], // resolvers awaiting the URL while a start is in progress
};
const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const TUNNEL_START_TIMEOUT_MS = 20_000;

function tunnelStatus() {
  return { status: tunnel.status, url: tunnel.url, error: tunnel.error };
}
function resolveTunnelWaiters() {
  const snap = tunnelStatus();
  for (const w of tunnel.waiters.splice(0)) w(snap);
}

function startTunnel() {
  // Idempotent: a running/starting tunnel just yields its current state.
  if (tunnel.status === "running") return Promise.resolve(tunnelStatus());
  if (tunnel.status === "starting") {
    return new Promise((resolve) => tunnel.waiters.push(resolve));
  }
  tunnel.status = "starting";
  tunnel.url = null;
  tunnel.error = null;

  const proc = spawn(
    "cloudflared",
    ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${PUBLIC_PORT}`],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  tunnel.proc = proc;

  const onData = (chunk) => {
    if (tunnel.url) return;
    const m = chunk.toString().match(TUNNEL_URL_RE);
    if (m) {
      tunnel.url = m[0];
      tunnel.status = "running";
      log("tunnel up:", tunnel.url);
      resolveTunnelWaiters();
    }
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData); // cloudflared prints the URL banner to stderr
  proc.on("exit", (code) => {
    log("cloudflared exited", code);
    if (tunnel.proc === proc) {
      tunnel.proc = null;
      if (tunnel.status !== "stopped") {
        // Unexpected death (crash/network) — an intentional stop already set
        // status "stopped" and revoked shares in stopTunnel(). Here the tunnel
        // vanished out from under live shares, so clear them now.
        tunnel.status = "error";
        tunnel.error = tunnel.url ? "tunnel process exited" : "tunnel failed to start";
        tunnel.url = null;
        void revokeAllSharesInSandbox();
        resolveTunnelWaiters();
      }
    }
  });
  proc.on("error", (e) => {
    log("cloudflared spawn error", e.message);
    if (tunnel.proc === proc) {
      tunnel.proc = null;
      tunnel.status = "error";
      tunnel.error = `could not start cloudflared: ${e.message}`;
      tunnel.url = null;
      resolveTunnelWaiters();
    }
  });

  return new Promise((resolve) => {
    tunnel.waiters.push(resolve);
    setTimeout(() => {
      if (tunnel.status === "starting") {
        tunnel.status = "error";
        tunnel.error = "timed out waiting for tunnel hostname";
        try { tunnel.proc?.kill("SIGTERM"); } catch {}
        tunnel.proc = null;
        resolveTunnelWaiters();
      }
    }, TUNNEL_START_TIMEOUT_MS);
  });
}

function stopTunnel() {
  const proc = tunnel.proc;
  tunnel.proc = null;
  tunnel.status = "stopped";
  tunnel.url = null;
  tunnel.error = null;
  // Kill the durable auth BEFORE the tunnel dies so a peer mid-request can't
  // slip through as it closes (same ordering the UI's stopSharing relies on).
  void revokeAllSharesInSandbox();
  if (proc) { try { proc.kill("SIGTERM"); } catch {} }
  resolveTunnelWaiters();
  return tunnelStatus();
}

process.on("SIGTERM", () => stopTunnel());
process.on("SIGINT", () => stopTunnel());

// Host-only gate for the front process's own /api/tunnel endpoints. Peers never
// hold the install cookie; same-origin blocks cross-site CSRF (the cookie is
// SameSite=Strict, but we check Origin explicitly for mutations too).
function isHostRequest(req) {
  const host = normHost(req.headers.host);
  const origin = req.headers.origin;
  if (origin) {
    try { if (normHost(new URL(origin).host) !== host) return false; } catch { return false; }
  }
  const cookies = parseCookies(req.headers.cookie);
  return !!DASHBOARD_TOKEN && ctEq(cookies[INSTALL_COOKIE] ?? "", DASHBOARD_TOKEN);
}
function sendJson(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { "content-type": "application/json", "content-length": buf.length });
  res.end(buf);
}
// Handle /api/tunnel entirely in the front process (cloudflared lives here, not
// in Next). Returns true if the request was handled.
async function handleTunnel(req, res) {
  if ((req.url || "").split("?")[0] !== "/api/tunnel") return false;
  if (!isHostRequest(req)) { sendJson(res, 403, { error: "host only" }); return true; }
  if (req.method === "GET") { sendJson(res, 200, tunnelStatus()); return true; }
  if (req.method === "POST") {
    const s = await startTunnel();
    sendJson(res, s.status === "running" ? 200 : 502, s);
    return true;
  }
  if (req.method === "DELETE") { sendJson(res, 200, stopTunnel()); return true; }
  sendJson(res, 405, { error: "method not allowed" });
  return true;
}

// ── 3. WebSocket bridge ──────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true });
const clients = new Set(); // { ws, scope }

function shouldForward(scope, type, data) {
  if (scope.kind === "host") return true;
  // Peer: only their session's live data.
  switch (type) {
    case "event":
      return !!data && typeof data.session_id === "string" && scope.allowed.has(data.session_id);
    case "presence":
      return !!data && data.sessionId === scope.ses;
    case "session-status": {
      // Track alias swaps for the peer's session so later events under the new
      // id still reach them (mirrors the browser's alias widening).
      if (data && (scope.allowed.has(data.aliasFrom) || scope.allowed.has(data.sessionId))) {
        if (data.sessionId) scope.allowed.add(data.sessionId);
        return true;
      }
      return false;
    }
    case "session-error":
      return !!data && (data.sessionId == null || scope.allowed.has(data.sessionId));
    case "sessions":   // content-free "refetch" ping
    case "skills":     // skills are shared
      return true;
    default:
      return false;    // anything unrecognized → host only
  }
}

function broadcast(type, data) {
  const frame = JSON.stringify({ type, data });
  for (const c of clients) {
    if (c.ws.readyState !== c.ws.OPEN) continue;
    if (shouldForward(c.scope, type, data)) {
      try { c.ws.send(frame); } catch { /* ignore */ }
    }
  }
}

// ── upstream: one SSE connection to Next's /api/stream (as host, localhost) ──
let upstreamReq = null;
function startUpstream() {
  const req = httpRequest({
    host: INTERNAL_HOST,
    port: INTERNAL_PORT,
    path: "/api/stream",
    method: "GET",
    headers: {
      host: `${INTERNAL_HOST}:${INTERNAL_PORT}`,
      origin: `http://${INTERNAL_HOST}:${INTERNAL_PORT}`,
      accept: "text/event-stream",
      cookie: `${INSTALL_COOKIE}=${DASHBOARD_TOKEN}`,
    },
  }, (res) => {
    if (res.statusCode !== 200) {
      log("upstream /api/stream status", res.statusCode, "- retrying");
      res.resume();
      return scheduleUpstreamRetry();
    }
    res.setEncoding("utf-8");
    let buf = "", evType = null, dataLines = [];
    const flush = () => {
      if (dataLines.length) {
        const raw = dataLines.join("\n");
        let data; try { data = JSON.parse(raw); } catch { data = null; }
        if (data !== null) broadcast(evType ?? "message", data);
      }
      evType = null; dataLines = [];
    };
    res.on("data", (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (line === "") { flush(); continue; }
        if (line.startsWith(":")) continue;
        if (line.startsWith("event:")) evType = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    });
    res.on("end", scheduleUpstreamRetry);
    res.on("close", scheduleUpstreamRetry);
    res.on("error", scheduleUpstreamRetry);
  });
  req.on("error", () => scheduleUpstreamRetry());
  req.end();
  upstreamReq = req;
}
let retryTimer = null;
function scheduleUpstreamRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; startUpstream(); }, 1000);
}

// ── 2. Reverse-proxy all HTTP to Next (transparent; Next does all auth) ──────
const server = createServer((creq, cres) => {
  // Tunnel control lives in this process (it owns the cloudflared child), so
  // intercept before the transparent proxy hands off to Next.
  if ((creq.url || "").split("?")[0] === "/api/tunnel") {
    void handleTunnel(creq, cres).catch(() => { try { sendJson(cres, 500, { error: "tunnel error" }); } catch {} });
    return;
  }
  const preq = httpRequest({
    host: INTERNAL_HOST,
    port: INTERNAL_PORT,
    method: creq.method,
    path: creq.url,
    headers: creq.headers, // preserves Host/Cookie/Origin → Next middleware sees the real request
  }, (pres) => {
    cres.writeHead(pres.statusCode ?? 502, pres.headers);
    pres.pipe(cres);
  });
  preq.on("error", () => { try { cres.writeHead(502); cres.end("bad gateway"); } catch {} });
  creq.pipe(preq);
});

// Raw upgrade proxy → internal Next server. Only used in dev, to carry Next's
// HMR websocket (/_next/webpack-hmr) through this front process. Reconstructs
// the upgrade request line + headers, replays any buffered `head`, then pipes
// bidirectionally.
function proxyUpgrade(req, socket, head) {
  const up = netConnect(INTERNAL_PORT, INTERNAL_HOST, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    }
    lines.push("", "");
    up.write(lines.join("\r\n"));
    if (head && head.length) up.write(head);
    socket.pipe(up);
    up.pipe(socket);
  });
  up.on("error", () => { try { socket.destroy(); } catch { /* ignore */ } });
  socket.on("error", () => { try { up.destroy(); } catch { /* ignore */ } });
}

server.on("upgrade", (req, socket, head) => {
  const url = req.url || "";
  if (!url.startsWith("/api/ws")) {
    // Dev: forward Next's HMR (and any other) upgrade to the internal server.
    // Prod: no such upgrades exist, so reject exactly as before.
    if (DEV) return proxyUpgrade(req, socket, head);
    socket.destroy();
    return;
  }
  const scope = authUpgrade(req);
  if (!scope) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }
  // A peer's share must still be live to open the feed — a revoked link can't
  // reconnect to keep watching.
  const gate = scope.kind === "peer" ? shareLive(scope.sid) : Promise.resolve(true);
  gate.then((live) => {
    if (!live) {
      try { socket.write("HTTP/1.1 403 Forbidden\r\n\r\n"); socket.destroy(); } catch {}
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const client = { ws, scope };
      clients.add(client);
      ws.send(JSON.stringify({ type: "ready", data: { kind: scope.kind } }));
      const ping = setInterval(() => { try { ws.ping(); } catch {} }, 20_000);
      ws.on("close", () => { clearInterval(ping); clients.delete(client); });
      ws.on("error", () => { clearInterval(ping); clients.delete(client); });
    });
  });
});

// Drop live peer feeds whose share got revoked mid-session. Poll every 5s and
// close any peer socket whose share the sandbox no longer holds (deduped by
// shareId so N peers on one share cost one check).
setInterval(async () => {
  const sids = new Set();
  for (const c of clients) {
    if (c.scope.kind === "peer" && c.scope.sid) sids.add(c.scope.sid);
  }
  if (sids.size === 0) return;
  const dead = new Set();
  await Promise.all([...sids].map(async (sid) => {
    if (!(await shareLive(sid))) dead.add(sid);
  }));
  if (dead.size === 0) return;
  for (const c of clients) {
    if (c.scope.kind === "peer" && dead.has(c.scope.sid)) {
      try { c.ws.close(4403, "share revoked"); } catch {}
      clients.delete(c);
    }
  }
}, 5000);

// ── boot: wait for Next, then listen + start the upstream relay ──────────────
// `ready` makes this a one-shot: once Next answers 200 we listen exactly once
// and stop polling. Without it, a keep-alive health socket (next dev keeps the
// connection open) fires a late `timeout` after success → a stray retry →
// onNextReady twice → ERR_SERVER_ALREADY_LISTEN. `Connection: close` also keeps
// each probe from lingering.
let ready = false;
function waitForNext(attempt = 0) {
  if (ready) return;
  const r = httpRequest(
    { host: INTERNAL_HOST, port: INTERNAL_PORT, path: "/api/health", method: "GET",
      headers: { connection: "close" }, timeout: 1000 },
    (res) => { res.resume(); res.statusCode === 200 ? onNextReady() : retry(); },
  );
  r.on("error", retry);
  r.on("timeout", () => { r.destroy(); retry(); });
  r.end();
  function retry() {
    if (ready) return;
    if (attempt > 600) { log("next never became ready"); process.exit(1); }
    setTimeout(() => waitForNext(attempt + 1), 250);
  }
}
function onNextReady() {
  if (ready) return;
  ready = true;
  server.listen(PUBLIC_PORT, PUBLIC_HOST, () => {
    log(`listening on ${PUBLIC_HOST}:${PUBLIC_PORT} → next on ${INTERNAL_HOST}:${INTERNAL_PORT}; ws at /api/ws`);
    startUpstream();
  });
}
waitForNext();

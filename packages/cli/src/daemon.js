// Persistent IMAP daemon. Listens on a Unix socket and serves JSON-RPC
// calls into @mailbox/core, reusing pooled IMAP connections so each
// downstream CLI invocation skips the 1-3s TCP+TLS+LOGIN handshake.
//
// Wire format: line-delimited JSON.
//   request:  {"id":1,"fn":"email.searchEmails","args":{...}}
//   response: {"id":1,"ok":true,"result":...}
//          or {"id":1,"ok":false,"error":"...","error_code":"..."}
//
// Special methods:
//   __ping           → {ok:true,result:{pong:true,version,started_at,stats}}
//   __reload         → re-resolve account credentials (auth.json edited)
//   __shutdown       → close connections and exit

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const core = require("@mailbox/core");
const { ImapPool } = require("@mailbox/core/src/services/imap_pool");
const { workflows, digest, monitor, inbox } = (() => {
  try { return require("@mailbox/workflows"); } catch { return {}; }
})();

function getSocketPath() {
  if (process.env.MAILBOX_DAEMON_SOCKET) return process.env.MAILBOX_DAEMON_SOCKET;
  const base = process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), ".cache", "mailbox");
  return path.join(base, `daemon-${process.getuid ? process.getuid() : "x"}.sock`);
}

function getPidFilePath() {
  return getSocketPath().replace(/\.sock$/, ".pid");
}

function _resolveFn(fnName) {
  const parts = String(fnName || "").split(".");
  if (parts.length !== 2) return null;
  const [ns, name] = parts;
  const namespaces = {
    accounts: core.accounts,
    email: core.email,
    sync: core.sync,
    digest, monitor, inbox,
  };
  const obj = namespaces[ns];
  if (!obj) return null;
  const fn = obj[name];
  if (typeof fn !== "function") return null;
  return fn.bind(obj);
}

async function startDaemon({ foreground = true, log = console.error } = {}) {
  const sockPath = getSocketPath();
  fs.mkdirSync(path.dirname(sockPath), { recursive: true });

  // If another daemon owns the socket, refuse to clobber it.
  if (fs.existsSync(sockPath)) {
    const reachable = await _probe(sockPath).catch(() => false);
    if (reachable) {
      throw Object.assign(new Error(`mailbox daemon already running on ${sockPath}`), { code: "EADDRINUSE" });
    }
    try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
  }

  const pool = new ImapPool();
  core.imap.setGlobalPool(pool);
  const startedAt = Date.now();

  const server = net.createServer((conn) => _handleConn(conn, { pool, startedAt, log }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, () => {
      try { fs.chmodSync(sockPath, 0o600); } catch { /* ignore */ }
      resolve();
    });
  });

  fs.writeFileSync(getPidFilePath(), String(process.pid), { mode: 0o600 });

  const cleanup = async () => {
    log(`[mailbox daemon] shutting down (pid=${process.pid})`);
    try { await pool.closeAll(); } catch { /* ignore */ }
    try { server.close(); } catch { /* ignore */ }
    try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
    try { fs.unlinkSync(getPidFilePath()); } catch { /* ignore */ }
    process.exit(0);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  log(`[mailbox daemon] listening on ${sockPath} (pid=${process.pid})`);
  return { server, pool, sockPath };
}

function _handleConn(conn, ctx) {
  let buffer = "";
  conn.setEncoding("utf8");
  conn.on("data", (chunk) => {
    buffer += chunk;
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      _dispatch(line, conn, ctx).catch((e) => ctx.log(`[mailbox daemon] dispatch error: ${e}`));
    }
  });
  conn.on("error", () => { /* ignore client disconnects */ });
}

async function _dispatch(line, conn, ctx) {
  let req;
  try { req = JSON.parse(line); } catch (e) {
    return _respond(conn, { id: null, ok: false, error: `invalid JSON: ${e.message}`, error_code: "invalid_argument" });
  }
  const id = req.id;
  const fnName = String(req.fn || "");

  if (fnName === "__ping") {
    return _respond(conn, { id, ok: true, result: {
      pong: true,
      pid: process.pid,
      uptime_ms: Date.now() - ctx.startedAt,
      pool: ctx.pool.stats(),
    } });
  }
  if (fnName === "__reload") {
    // Account credentials are read fresh from auth.json on each call, so a
    // reload mostly means: drop existing connections so the next acquire
    // picks up new creds.
    await ctx.pool.closeAll();
    return _respond(conn, { id, ok: true, result: { reloaded: true } });
  }
  if (fnName === "__shutdown") {
    _respond(conn, { id, ok: true, result: { shutting_down: true } });
    setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);
    return;
  }

  const fn = _resolveFn(fnName);
  if (!fn) {
    return _respond(conn, { id, ok: false, error: `unknown fn: ${fnName}`, error_code: "unknown_fn" });
  }
  const t0 = Date.now();
  try {
    const result = await fn(req.args || {});
    const dt = Date.now() - t0;
    if (process.env.MAILBOX_DAEMON_TRACE) ctx.log(`[mailbox daemon] ${fnName} ok in ${dt}ms`);
    _respond(conn, { id, ok: true, result });
  } catch (e) {
    const dt = Date.now() - t0;
    if (process.env.MAILBOX_DAEMON_TRACE) ctx.log(`[mailbox daemon] ${fnName} FAIL in ${dt}ms: ${(e && e.message) || e}`);
    _respond(conn, { id, ok: false, error: (e && e.message) || "failed", error_code: "operation_failed" });
  }
}

function _respond(conn, payload) {
  try { conn.write(JSON.stringify(payload) + "\n"); } catch { /* ignore */ }
}

async function _probe(sockPath) {
  return new Promise((resolve) => {
    const c = net.createConnection(sockPath);
    c.once("connect", () => { c.end(); resolve(true); });
    c.once("error", () => resolve(false));
    setTimeout(() => { try { c.destroy(); } catch {} resolve(false); }, 500);
  });
}

module.exports = { startDaemon, getSocketPath, getPidFilePath };

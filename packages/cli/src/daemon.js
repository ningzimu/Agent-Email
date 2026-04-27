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

async function startDaemon({ foreground = true, log = console.error, syncIntervalMs = 0, syncAccountId = "" } = {}) {
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
  const stats = { syncs_attempted: 0, syncs_ok: 0, syncs_failed: 0, last_sync_at: null, last_sync_error: null };

  const server = net.createServer((conn) => _handleConn(conn, { pool, startedAt, log, stats }));
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, () => {
      try { fs.chmodSync(sockPath, 0o600); } catch { /* ignore */ }
      resolve();
    });
  });

  fs.writeFileSync(getPidFilePath(), String(process.pid), { mode: 0o600 });

  // Background sync loop. Runs in-process so it shares the same pooled
  // IMAP connections as RPC traffic — no extra TCP handshakes for the
  // periodic refresh. AI clients hitting `email list` (without --live)
  // then read from the local SQLite cache instead of doing IMAP at all.
  let syncTimer = null;
  if (syncIntervalMs > 0) {
    const runSync = async () => {
      stats.syncs_attempted += 1;
      try {
        const r = await core.sync.force({ account_id: syncAccountId || "", full: false });
        if (r && r.success === false) throw new Error(r.error || "sync failed");
        stats.syncs_ok += 1;
        stats.last_sync_at = new Date().toISOString();
        stats.last_sync_error = null;
      } catch (e) {
        stats.syncs_failed += 1;
        stats.last_sync_error = (e && e.message) || String(e);
      }
    };
    // First sync after a short delay so we don't block startup.
    setTimeout(() => { runSync(); }, 5_000);
    syncTimer = setInterval(runSync, syncIntervalMs);
    if (typeof syncTimer.unref === "function") syncTimer.unref();
    log(`[mailbox daemon] background sync every ${Math.round(syncIntervalMs / 1000)}s${syncAccountId ? ` (account ${syncAccountId})` : ""}`);
  }

  const cleanup = async () => {
    log(`[mailbox daemon] shutting down (pid=${process.pid})`);
    if (syncTimer) clearInterval(syncTimer);
    try { await pool.closeAll(); } catch { /* ignore */ }
    try { server.close(); } catch { /* ignore */ }
    try { fs.unlinkSync(sockPath); } catch { /* ignore */ }
    try { fs.unlinkSync(getPidFilePath()); } catch { /* ignore */ }
    process.exit(0);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);

  log(`[mailbox daemon] listening on ${sockPath} (pid=${process.pid})`);
  return { server, pool, sockPath, stats };
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
      sync: ctx.stats || null,
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

// ---------- autostart (launchd / systemd-user) ----------

const LAUNCHD_LABEL = "com.leeguoo.mailbox.daemon";
const SYSTEMD_UNIT = "mailbox-daemon.service";

function _resolveCliExecutable() {
  // Returns { node, script } — node binary (absolute) and the .js entry
  // point (absolute, may not be marked executable so launchd needs to
  // invoke it via node explicitly).
  const argv1 = process.argv[1] || "";
  const node = process.execPath || "node";
  if (argv1 && fs.existsSync(argv1)) return { node, script: argv1 };
  return { node, script: "mailbox" };
}

function _autostartPaths() {
  if (process.platform === "darwin") {
    return {
      kind: "launchd",
      unitPath: path.join(os.homedir(), "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
      logPath: path.join(os.homedir(), "Library", "Logs", "mailbox-daemon.log"),
    };
  }
  if (process.platform === "linux") {
    const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
    return {
      kind: "systemd",
      unitPath: path.join(xdg, "systemd", "user", SYSTEMD_UNIT),
      logPath: "",
    };
  }
  return { kind: "unsupported", unitPath: "", logPath: "" };
}

function _renderLaunchdPlist({ node, script, syncIntervalSec, logPath }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${script}</string>
    <string>daemon</string>
    <string>start</string>
    <string>--sync-interval</string><string>${syncIntervalSec}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${logPath}</string>
  <key>StandardErrorPath</key><string>${logPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
`;
}

function _renderSystemdUnit({ node, script, syncIntervalSec }) {
  return `[Unit]
Description=Mailbox CLI persistent IMAP daemon
After=network-online.target

[Service]
ExecStart=${node} ${script} daemon start --sync-interval ${syncIntervalSec}
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
}

async function installAutostart({ syncIntervalSec = 300 } = {}) {
  const info = _autostartPaths();
  if (info.kind === "unsupported") {
    return { success: false, error: `autostart not supported on platform ${process.platform}`, error_code: "unsupported" };
  }
  const { node, script } = _resolveCliExecutable();
  fs.mkdirSync(path.dirname(info.unitPath), { recursive: true });

  if (info.kind === "launchd") {
    fs.mkdirSync(path.dirname(info.logPath), { recursive: true });
    const body = _renderLaunchdPlist({ node, script, syncIntervalSec, logPath: info.logPath });
    fs.writeFileSync(info.unitPath, body, { mode: 0o644 });
    // Best-effort load. User may need to do it manually if SIP-locked.
    let activate = "";
    try {
      const { execFileSync } = require("child_process");
      execFileSync("launchctl", ["unload", info.unitPath], { stdio: "ignore" });
    } catch { /* not previously loaded — fine */ }
    try {
      const { execFileSync } = require("child_process");
      execFileSync("launchctl", ["load", "-w", info.unitPath], { stdio: "ignore" });
      activate = `launchctl loaded — daemon will start now and at every login. Logs: ${info.logPath}`;
    } catch (e) {
      activate = `wrote plist; load it manually: launchctl load -w ${info.unitPath}`;
    }
    return { success: true, unit_path: info.unitPath, log_path: info.logPath, exe: `${node} ${script}`, sync_interval_sec: syncIntervalSec, activate_hint: activate };
  }

  if (info.kind === "systemd") {
    const body = _renderSystemdUnit({ node, script, syncIntervalSec });
    fs.writeFileSync(info.unitPath, body, { mode: 0o644 });
    let activate = `systemctl --user daemon-reload && systemctl --user enable --now ${SYSTEMD_UNIT}`;
    try {
      const { execFileSync } = require("child_process");
      execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
      execFileSync("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT], { stdio: "ignore" });
      activate = `systemd unit enabled and started`;
    } catch { /* leave activate as the manual instruction */ }
    return { success: true, unit_path: info.unitPath, exe: `${node} ${script}`, sync_interval_sec: syncIntervalSec, activate_hint: activate };
  }

  return { success: false, error: "unknown autostart kind", error_code: "operation_failed" };
}

async function uninstallAutostart() {
  const info = _autostartPaths();
  if (info.kind === "unsupported") {
    return { success: false, error: `autostart not supported on platform ${process.platform}`, error_code: "unsupported" };
  }
  if (!fs.existsSync(info.unitPath)) {
    return { success: true, unit_path: "" };
  }
  if (info.kind === "launchd") {
    try {
      const { execFileSync } = require("child_process");
      execFileSync("launchctl", ["unload", info.unitPath], { stdio: "ignore" });
    } catch { /* ignore */ }
  } else if (info.kind === "systemd") {
    try {
      const { execFileSync } = require("child_process");
      execFileSync("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT], { stdio: "ignore" });
    } catch { /* ignore */ }
  }
  try { fs.unlinkSync(info.unitPath); } catch { /* ignore */ }
  return { success: true, unit_path: info.unitPath };
}

module.exports = {
  startDaemon, getSocketPath, getPidFilePath,
  installAutostart, uninstallAutostart,
};

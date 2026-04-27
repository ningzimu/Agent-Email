// Transparent core proxy: each call routes through the mailbox daemon's
// Unix socket if one is reachable, otherwise falls back to the original
// in-process implementation. Lets every existing action in main.js keep
// calling `email.searchEmails(args)` etc. without knowing whether a
// daemon is around.

const net = require("net");
const fs = require("fs");
const realCore = require("@mailbox/core");
const realWorkflows = (() => {
  try { return require("@mailbox/workflows"); } catch { return {}; }
})();
const { getSocketPath } = require("./daemon");

const CONNECT_TIMEOUT_MS = Number(process.env.MAILBOX_DAEMON_CONNECT_TIMEOUT_MS || 200);

let _attempted = false;
let _client = null;

class DaemonClient {
  constructor(conn) {
    this.conn = conn;
    this.buffer = "";
    this.nextId = 1;
    this.pending = new Map();
    conn.setEncoding("utf8");
    conn.on("data", (chunk) => this._onData(chunk));
    conn.on("close", () => this._failAll(new Error("daemon connection closed")));
    conn.on("error", () => this._failAll(new Error("daemon connection error")));
  }
  _onData(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(Object.assign(new Error(msg.error || "daemon error"), { code: msg.error_code }));
    }
  }
  _failAll(err) {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
  call(fn, args) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      try {
        this.conn.write(JSON.stringify({ id, fn, args: args || {} }) + "\n");
      } catch (e) {
        this.pending.delete(id);
        reject(e);
      }
    });
  }
  close() {
    try { this.conn.end(); } catch { /* ignore */ }
  }
}

async function _maybeConnect() {
  if (_attempted) return _client;
  _attempted = true;
  // Daemon disabled by env knob (useful when an agent has no daemon and
  // wants to skip the probe latency).
  if (String(process.env.MAILBOX_NO_DAEMON || "").trim() === "1") return null;
  const sockPath = getSocketPath();
  if (!fs.existsSync(sockPath)) return null;
  return new Promise((resolve) => {
    const conn = net.createConnection(sockPath);
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      try { conn.destroy(); } catch { /* ignore */ }
      resolve(null);
    }, CONNECT_TIMEOUT_MS);
    const settle = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(val);
    };
    conn.once("connect", () => {
      _client = new DaemonClient(conn);
      // Note: do NOT unref the socket here. Every action handler ends with
      // process.exit(rc), so the socket lifetime is fine — but unref'ing
      // would let Node exit before the daemon response arrives, killing
      // the in-flight call.
      settle(_client);
    });
    conn.once("error", () => settle(null));
  });
}

// Functions that mutate remote state. If a daemon RPC fails AFTER we've
// already written the request to the socket, we cannot tell whether the
// daemon performed the action — falling back to in-process would risk
// double-execution (sent emails, double-deletes, etc). For this allow-list
// we surface the RPC failure to the caller instead and let them retry.
const MUTATING_FNS = new Set([
  "email.sendEmail",
  "email.deleteEmails",
  "email.markEmails",
  "email.flagEmail",
  "email.moveEmails",
  "email.replyEmail",
  "email.forwardEmail",
  "email.downloadAttachments",
  "sync.force",
  "sync.init",
  "digest.run",
  "monitor.run",
  "inbox.run",
]);

function _wrapNamespace(nsName, realObj) {
  const handler = {
    get(_, fname) {
      if (typeof fname !== "string") return undefined;
      if (fname === "then") return undefined; // not a thenable
      const direct = realObj && realObj[fname];
      // For non-function exports (constants etc.), pass straight through.
      if (typeof direct !== "function") return direct;
      const fullName = `${nsName}.${fname}`;
      return async function (...callArgs) {
        const args = callArgs[0]; // every core fn takes a single options object
        const isMutator = MUTATING_FNS.has(fullName);
        const isDryRun = isMutator && args && (args.dry_run === true);
        const client = await _maybeConnect();
        if (client) {
          try {
            return await client.call(fullName, args);
          } catch (e) {
            const msg = e && e.message ? e.message : String(e);
            // For mutating calls that aren't dry-run, refuse to retry
            // in-process: the daemon may have already performed the work
            // and we'd execute it twice. Surface the failure instead.
            if (isMutator && !isDryRun) {
              if (process.env.MAILBOX_DAEMON_DEBUG) process.stderr.write(`mailbox: daemon call ${fullName} failed: ${msg}; refusing fallback for mutating call\n`);
              return {
                success: false,
                error: `daemon RPC failed for ${fullName}: ${msg}. Refusing to fall back to direct execution because it may have already mutated state. Re-check before retrying.`,
                error_code: "daemon_rpc_failed",
                daemon_rpc_failed: true,
              };
            }
            if (process.env.MAILBOX_DAEMON_DEBUG) process.stderr.write(`mailbox: daemon call ${fullName} failed: ${msg}; falling back to direct\n`);
          }
        }
        return direct.apply(realObj, callArgs);
      };
    },
  };
  return new Proxy({}, handler);
}

function makeProxies() {
  return {
    accounts: _wrapNamespace("accounts", realCore.accounts),
    email: _wrapNamespace("email", realCore.email),
    sync: _wrapNamespace("sync", realCore.sync),
    imap: realCore.imap, // not RPC'd — internal helper only
    smtp: realCore.smtp, // not RPC'd — internal helper only
    digest: _wrapNamespace("digest", realWorkflows.digest || {}),
    monitor: _wrapNamespace("monitor", realWorkflows.monitor || {}),
    inbox: _wrapNamespace("inbox", realWorkflows.inbox || {}),
  };
}

module.exports = { makeProxies };

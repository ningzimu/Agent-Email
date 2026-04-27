// Per-account persistent ImapFlow connection pool. Lives in a long-running
// process (the mailbox daemon). Sends NOOP every 25 minutes so the server's
// ~30 minute idle disconnect doesn't kick us off, reconnects transparently
// when the underlying socket dies.
//
// One client per account; per-account async mutex serializes mailbox switches
// so two requests on the same account don't fight over the selected folder.

const { ImapFlow } = require("imapflow");

const KEEPALIVE_MS = 25 * 60 * 1000; // 25 minutes
const CONNECT_TIMEOUT_MS = 30 * 1000;

function _allowInsecureTls() {
  return String(process.env.MAILBOX_ALLOW_INSECURE_TLS || "").trim() === "1";
}

function _buildClient(account) {
  const port = Number(account.imap.port);
  const secure = Boolean(account.imap.secure);
  return new ImapFlow({
    host: account.imap.host,
    port,
    secure,
    requireTLS: !secure,
    auth: { user: account.email, pass: account.password },
    tls: { rejectUnauthorized: !_allowInsecureTls(), minVersion: "TLSv1.2" },
    logger: false,
  });
}

class ImapPool {
  constructor() {
    // accountId → { client, lastUsed, keepaliveTimer, mutex: Promise }
    this._entries = new Map();
  }

  // Internal mutex helper: each account gets a serialized chain of work.
  async _withMutex(accountId, fn) {
    const prev = this._entries.get(accountId)?.mutex || Promise.resolve();
    let release;
    const next = new Promise((res) => (release = res));
    if (this._entries.get(accountId)) this._entries.get(accountId).mutex = next;
    try {
      await prev;
      return await fn();
    } finally {
      release();
    }
  }

  async _ensureClient(account) {
    let entry = this._entries.get(account.id);
    if (entry && entry.client && entry.client.usable) {
      entry.lastUsed = Date.now();
      return entry.client;
    }
    if (entry && entry.keepaliveTimer) clearInterval(entry.keepaliveTimer);

    const client = _buildClient(account);
    const connectPromise = client.connect();
    let timeoutId;
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`IMAP connect timeout (${CONNECT_TIMEOUT_MS}ms) for ${account.email}`)), CONNECT_TIMEOUT_MS);
    });
    try {
      await Promise.race([connectPromise, timeout]);
    } finally {
      clearTimeout(timeoutId);
    }

    entry = entry || { mutex: Promise.resolve() };
    entry.client = client;
    entry.lastUsed = Date.now();
    entry.keepaliveTimer = setInterval(() => {
      const e = this._entries.get(account.id);
      if (!e || !e.client || !e.client.usable) return;
      // Best-effort NOOP; ignore failures, the next acquire() will reconnect.
      e.client.noop().catch(() => {});
    }, KEEPALIVE_MS);
    if (typeof entry.keepaliveTimer.unref === "function") entry.keepaliveTimer.unref();

    client.on("close", () => {
      const e = this._entries.get(account.id);
      if (e && e.keepaliveTimer) clearInterval(e.keepaliveTimer);
      // Leave the entry but mark as unusable; next acquire rebuilds.
      if (e) e.client = null;
    });

    this._entries.set(account.id, entry);
    return client;
  }

  // Run fn(client) with a guaranteed-live client, serialized per-account.
  async withClient(account, fn) {
    return this._withMutex(account.id, async () => {
      // One automatic retry on EPIPE / close / connection errors that bubble
      // up before we even get to do the work.
      try {
        const client = await this._ensureClient(account);
        return await fn(client);
      } catch (err) {
        const msg = (err && err.message) || "";
        if (/usable|EPIPE|ECONNRESET|connection.*closed|not connected/i.test(msg)) {
          // Force a fresh connection and retry once.
          const e = this._entries.get(account.id);
          if (e && e.client) {
            try { await e.client.logout(); } catch { /* ignore */ }
            e.client = null;
          }
          const client = await this._ensureClient(account);
          return await fn(client);
        }
        throw err;
      }
    });
  }

  async closeAll() {
    for (const [id, entry] of this._entries.entries()) {
      if (entry.keepaliveTimer) clearInterval(entry.keepaliveTimer);
      if (entry.client) {
        try { await entry.client.logout(); } catch { /* ignore */ }
      }
      this._entries.delete(id);
    }
  }

  stats() {
    const out = [];
    for (const [id, entry] of this._entries.entries()) {
      out.push({
        account_id: id,
        connected: Boolean(entry.client && entry.client.usable),
        last_used_ms_ago: entry.lastUsed ? Date.now() - entry.lastUsed : null,
      });
    }
    return out;
  }
}

module.exports = { ImapPool };

const fs = require("fs");
const path = require("path");

const { paths } = require("@mailbox/shared");

const accounts = require("./accounts");
const { withImapClient } = require("./imap");
const { sendMail } = require("./smtp");
const { formatDateTime, firstAddress, hasAttachmentsFromBodyStructure, formatSize } = require("./format");

function _isTestMode() {
  // Internal sentinel only — kept narrowly named to avoid colliding with any
  // env a user might set. Tests must opt in explicitly.
  return String(process.env.MAILBOX_INTERNAL_TEST_MODE || "").trim() === "1";
}

// Hard caps to defend against hostile mail. Override via env if needed.
const MAX_MESSAGE_BYTES = Number(process.env.MAILBOX_MAX_MESSAGE_BYTES || 50 * 1024 * 1024); // 50 MiB
const MAX_ATTACHMENT_BYTES = Number(process.env.MAILBOX_MAX_ATTACHMENT_BYTES || 25 * 1024 * 1024); // 25 MiB per file
const MAX_ATTACHMENTS_TOTAL = Number(process.env.MAILBOX_MAX_ATTACHMENTS_BYTES || 100 * 1024 * 1024); // 100 MiB total

async function _safeParse(source) {
  if (source && Buffer.isBuffer(source) && source.length > MAX_MESSAGE_BYTES) {
    throw new Error(`Message exceeds MAILBOX_MAX_MESSAGE_BYTES (${MAX_MESSAGE_BYTES})`);
  }
  const { simpleParser } = require("mailparser");
  return simpleParser(source, {
    maxHtmlLengthToParse: MAX_MESSAGE_BYTES,
  });
}

function _normalizeFolder(folder) {
  const f = String(folder || "").trim();
  if (!f) return "INBOX";
  if (f.toLowerCase() === "all") return "INBOX";
  return f;
}

// imapflow's client.list() returns Promise<Array> in current versions but has
// historically been documented as async-iterable. Tolerate both shapes.
async function _listMailboxes(client) {
  if (typeof client.list !== "function") return [];
  const r = client.list();
  if (r && typeof r.then === "function") {
    const arr = await r;
    return Array.isArray(arr) ? arr : [];
  }
  if (r && typeof r[Symbol.asyncIterator] === "function") {
    const out = [];
    for await (const mb of r) out.push(mb);
    return out;
  }
  return Array.isArray(r) ? r : [];
}

// Pick selectable folder paths to scan when the caller asks for --folder all.
// Skip \Noselect containers (e.g. "[Gmail]") and Gmail's "All Mail" alias to
// avoid double-counting messages that already appear in INBOX/Spam/etc.
function _selectableFoldersFor(mailboxes) {
  const out = [];
  for (const mb of mailboxes || []) {
    const path = mb.path || mb.name || "";
    if (!path) continue;
    const flags = Array.isArray(mb.flags) ? mb.flags : [];
    const flagSet = new Set(flags.map((f) => String(f)));
    if (flagSet.has("\\Noselect") || flagSet.has("\\NonExistent")) continue;
    const special = String(mb.specialUse || "");
    if (special === "\\All") continue; // Gmail's "All Mail" duplicates everything else.
    out.push(path);
  }
  return out;
}

function _uidsSortedDesc(uids) {
  return [...uids].map((n) => Number(n)).filter((n) => Number.isFinite(n)).sort((a, b) => b - a);
}

// Compare email date strings as instants, not lex strings. Falls back to lex
// only when both dates are unparseable, so we still get stable ordering.
function _compareDatesDesc(a, b) {
  const av = a ? Date.parse(String(a).replace(" ", "T")) : NaN;
  const bv = b ? Date.parse(String(b).replace(" ", "T")) : NaN;
  const aOk = Number.isFinite(av);
  const bOk = Number.isFinite(bv);
  if (aOk && bOk) return bv - av;
  if (aOk) return -1;
  if (bOk) return 1;
  return String(b || "").localeCompare(String(a || ""));
}

function _dateOnly(raw) {
  return /^\d{4}-\d{2}-\d{2}$/.test(raw);
}

function _parseDateInput(raw, { end = false } = {}) {
  const value = String(raw || "").trim();
  if (!value) return { date: null, sql: "" };

  if (_dateOnly(value)) {
    const start = new Date(`${value}T00:00:00`);
    if (Number.isNaN(start.getTime())) return { date: null, sql: "" };
    if (end) {
      const before = new Date(start.getTime());
      before.setDate(before.getDate() + 1);
      return { date: before, sql: `${value} 23:59:59` };
    }
    return { date: start, sql: `${value} 00:00:00` };
  }

  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { date: null, sql: "" };
  const sql = formatDateTime(d) || value;
  if (end) return { date: new Date(d.getTime() + 1000), sql };
  return { date: d, sql };
}

async function _fetchEmailsForAccount({ account, folder, limit, offset, unreadOnly, since, before, previewChars = 0 }) {
  const openFolder = _normalizeFolder(folder);
  return withImapClient(account, async (client) => {
    const st = await client.mailboxOpen(openFolder);
    // ImapFlow defaults to sequence numbers; force UID mode.
    const criteria = unreadOnly ? { seen: false } : { all: true };
    if (since) criteria.since = since;
    if (before) criteria.before = before;
    const uids = await client.search(criteria, { uid: true });
    const sorted = _uidsSortedDesc(uids);
    const slice = sorted.slice(offset, offset + limit);

    const wantPreview = previewChars > 0 && slice.length > 0 && slice.length <= 50;
    const emails = [];
    for await (const msg of client.fetch(
      slice,
      {
        envelope: true,
        flags: true,
        internalDate: true,
        bodyStructure: true,
        source: wantPreview,
      },
      { uid: true }
    )) {
      const env = msg.envelope || {};
      const flags = msg.flags || new Set([]);
      const unread = !flags.has("\\Seen");
      const item = {
        id: String(msg.uid),
        uid: String(msg.uid),
        gid: `${account.id}:${msg.uid}`,
        message_id: env.messageId || "",
        subject: env.subject || "",
        from: firstAddress(env.from),
        date: formatDateTime(msg.internalDate || env.date),
        unread,
        has_attachments: hasAttachmentsFromBodyStructure(msg.bodyStructure),
        account: account.email,
        account_id: account.id,
        folder: openFolder,
        source: "imap_fetch",
      };
      if (wantPreview && msg.source) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const parsed = await _safeParse(msg.source);
          const txt = String(parsed.text || "").replace(/\s+/g, " ").trim();
          item.preview = txt.slice(0, previewChars);
          if (txt.length > previewChars) item.preview_truncated = true;
        } catch {
          item.preview = "";
        }
      }
      emails.push(item);
    }

    return {
      success: true,
      emails,
      total_in_folder: Number(st.exists || 0),
      unread_count: Number(st.unseen || 0),
      fetched: emails.length,
      folder: openFolder,
    };
  });
}

async function listEmails({
  limit = 100,
  offset = 0,
  unread_only = false,
  folder = "all",
  account_id = "",
  use_cache = true,
  date_from = "",
  date_to = "",
  preview_chars = 0,
} = {}) {
  const previewChars = Math.max(0, Number(preview_chars || 0));
  // The cache backend returns envelope-only rows; preview requires live IMAP.
  if (previewChars > 0) use_cache = false;
  const lim = Math.max(0, Number(limit || 0));
  const off = Math.max(0, Number(offset || 0));
  const unreadOnly = Boolean(unread_only);
  const mergedLimit = lim > 0 ? lim + off : 0;
  const fromParsed = _parseDateInput(date_from);
  const toParsed = _parseDateInput(date_to, { end: true });
  const since = fromParsed.date;
  const before = toParsed.date;
  const sqlFrom = fromParsed.sql;
  const sqlTo = toParsed.sql;

  // Cache read from email_sync.db (python-compatible schema). Falls back to IMAP.
  if (use_cache) {
    try {
      const pc = paths.getPathConfig();
      const resolved = account_id ? accounts.getAccountByIdOrEmail(account_id) : null;
      const resolvedId = resolved && resolved.success ? resolved.account.id : "";
      const cache = await require("../storage/sync_db").listEmailsFromCache({
        dbPath: pc.emailSyncDb,
        accountId: resolvedId || "",
        folder,
        unreadOnly,
        limit: lim,
        offset: off,
        dateFrom: sqlFrom,
        dateTo: sqlTo,
      });
      if (cache && cache.success) {
        // Add multi-account metadata similar to Python contract.
        const all = accounts.getAllAccountsResolved();
        const accounts_count = resolvedId ? 1 : (all.success ? (all.accounts || []).length : 0);
        return {
          ...cache,
          total_emails: cache.total_in_folder,
          total_unread: cache.unread_count,
          accounts_count,
          accounts_info: [],
        };
      }
    } catch (e) {
      // Cache failed → fall through to live IMAP. Surface the reason so users
      // can tell why use_cache=true didn't actually use the cache.
      process.stderr.write(`mailbox: cache read failed, falling back to live IMAP: ${e && e.message ? e.message : e}\n`);
    }
  }

  const results = [];

  if (account_id) {
    const acc = accounts.getAccountByIdOrEmail(account_id);
    if (!acc.success) return acc;
    const r = await _fetchEmailsForAccount({ account: acc.account, folder, limit: lim, offset: off, unreadOnly, since, before, previewChars });
    if (!r.success) return r;
    results.push({ account: acc.account, ...r });
  } else {
    const all = accounts.getAllAccountsResolved();
    if (!all.success) return all;
    const list = all.accounts || [];
    if (!list.length) {
      // Keep Python-like behavior: no accounts -> success with empty.
      return {
        success: true,
        emails: [],
        total_in_folder: 0,
        unread_count: 0,
        total_emails: 0,
        total_unread: 0,
        accounts_count: 0,
        accounts_info: [],
        offset: off,
        limit: lim,
        from_cache: false,
      };
    }

    for (const acc of list) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const r = await _fetchEmailsForAccount({
          account: acc,
          folder,
          limit: mergedLimit,
          offset: 0,
          unreadOnly,
          since,
          before,
          previewChars,
        });
        results.push({ account: acc, ...r });
      } catch (e) {
        results.push({ account: acc, success: false, error: e && e.message ? e.message : "fetch failed" });
      }
    }
  }

  const ok = results.filter((r) => r.success);
  const allEmails = ok.flatMap((r) => r.emails || []);
  allEmails.sort((a, b) => _compareDatesDesc(a.date, b.date));
  const emails = lim > 0 ? allEmails.slice(off, off + lim) : [];

  const returnedByAccount = new Map();
  for (const e of emails) {
    const key = e.account_id || e.account || "";
    if (!key) continue;
    returnedByAccount.set(key, (returnedByAccount.get(key) || 0) + 1);
  }

  const accounts_info = results.map((r) => {
    const total = r.total_in_folder != null ? r.total_in_folder : 0;
    const unread = r.unread_count != null ? r.unread_count : 0;
    const fetched_raw = (r.emails || []).length;
    const accountId = r.account && r.account.id ? r.account.id : "";
    const accountEmail = r.account && r.account.email ? r.account.email : "";
    const key = accountId || accountEmail;
    const returned = key ? returnedByAccount.get(key) || 0 : 0;
    return {
      account: accountEmail,
      account_id: accountId,
      total,
      unread,
      fetched: returned,
      fetched_raw,
    };
  });

  const total_in_folder = ok.reduce((sum, r) => sum + Number(r.total_in_folder || 0), 0);
  const unread_count = ok.reduce((sum, r) => sum + Number(r.unread_count || 0), 0);

  return {
    success: ok.length === results.length,
    emails,
    total_in_folder,
    unread_count,
    total_emails: total_in_folder,
    total_unread: unread_count,
    accounts_count: results.length,
    accounts_info,
    offset: off,
    limit: lim,
    from_cache: false,
  };
}

async function searchEmails({ query, from = "", subject = "", account_id = "", date_from = "", date_to = "", limit = 50, offset = 0, unread_only = false, folder = "all", preview_chars = 0 } = {}) {
  const previewChars = Math.max(0, Number(preview_chars || 0));
  const q = String(query || "").trim();
  const fromQ = String(from || "").trim();
  const subjQ = String(subject || "").trim();

  const lim = Math.max(0, Number(limit || 0));
  const off = Math.max(0, Number(offset || 0));
  const unreadOnly = Boolean(unread_only);

  const started = Date.now();
  const folderRaw = String(folder || "").trim();
  const scanAll = folderRaw.toLowerCase() === "all";
  const openFolder = _normalizeFolder(folder);

  const df = date_from ? new Date(String(date_from)) : null;
  const dt = date_to ? new Date(String(date_to)) : null;
  const since = df && !Number.isNaN(df.getTime()) ? df : null;
  const before = dt && !Number.isNaN(dt.getTime()) ? dt : null;

  if (!q && !fromQ && !subjQ && !since && !before && !unreadOnly) {
    return { success: false, error: "Provide at least one of query, from, subject, date_from, date_to, unread_only" };
  }

  const baseCriteria = {};
  if (unreadOnly) baseCriteria.seen = false;
  else baseCriteria.all = true;

  // Prefer server-side filtering.
  if (q) baseCriteria.text = q;
  if (fromQ) baseCriteria.from = fromQ;
  if (subjQ) baseCriteria.subject = subjQ;
  if (since) baseCriteria.since = since;
  if (before) baseCriteria.before = before;

  // Gmail's IMAP TEXT search is unreliable across providers — and many
  // Chinese providers (QQ/163) ignore TEXT entirely and return everything.
  // For Gmail we have X-GM-RAW (the same engine the web UI uses), which is
  // dramatically more accurate. We build a Gmail query string and pass it
  // through imapflow's `gmailRaw` criterion when the account is Gmail.
  function _gmailRawFor(acc) {
    const host = String((acc && acc.imap && acc.imap.host) || "").toLowerCase();
    const provider = String((acc && acc.provider) || "").toLowerCase();
    const isGmail = provider === "gmail" || host.includes("gmail") || host.includes("googlemail");
    if (!isGmail) return null;
    const parts = [];
    if (q) parts.push(q.includes(" ") ? `"${q.replace(/"/g, '\\"')}"` : q);
    if (fromQ) parts.push(`from:${fromQ}`);
    if (subjQ) parts.push(subjQ.includes(" ") ? `subject:"${subjQ.replace(/"/g, '\\"')}"` : `subject:${subjQ}`);
    if (since) parts.push(`after:${_gmailDate(since)}`);
    if (before) parts.push(`before:${_gmailDate(before)}`);
    if (unreadOnly) parts.push("is:unread");
    return parts.join(" ");
  }
  function _gmailDate(d) {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${y}/${m}/${day}`;
  }

  const failed_accounts = [];
  const perAccount = [];

  const targets = [];
  if (account_id) {
    const acc = accounts.getAccountByIdOrEmail(account_id);
    if (!acc.success) return acc;
    targets.push(acc.account);
  } else {
    const all = accounts.getAllAccountsResolved();
    if (!all.success) return all;
    targets.push(...(all.accounts || []));
  }

  // Fetch more than needed per account so we can merge and slice globally.
  const perAccountFetchLimit = Math.max(lim + off, 200);

  async function _searchOneFolder(client, acc, folderPath) {
    const lock = await client.getMailboxLock(folderPath);
    try {
      const gmailRaw = _gmailRawFor(acc);
      const criteria = gmailRaw
        ? { gmailRaw, ...(unreadOnly ? { seen: false } : {}) }
        : baseCriteria;
      // Known-broken IMAP servers where SEARCH TEXT/FROM/SUBJECT either returns
      // every UID, or returns 0 for any non-ASCII / substring match. These
      // providers force client-side filtering whenever the caller supplied
      // any text filter, regardless of what SEARCH returned.
      const host = String((acc && acc.imap && acc.imap.host) || "").toLowerCase();
      const provider = String((acc && acc.provider) || "").toLowerCase();
      const isBrokenSearchProvider = !gmailRaw && (
        ["163", "qq", "126", "sina", "yeah", "aliyun", "outlook"].includes(provider) ||
        /(?:163|126|qq|sina|yeah|aliyun|mxhichina)\.com|\.qq\.com|outlook\.com/.test(host)
      );
      const hadTextFilter = !gmailRaw && (q || fromQ || subjQ);
      let usedClientFilter = false;
      let uids;
      let total = 0;
      const mailboxTotal = Number((client.mailbox && client.mailbox.exists) || 0);

      if (hadTextFilter && isBrokenSearchProvider) {
        usedClientFilter = true;
      } else {
        uids = await client.search(criteria, { uid: true });
        total = Array.isArray(uids) ? uids.length : 0;
        // Generic fallback: SEARCH returned almost the whole mailbox even
        // though we asked for a text filter — it ignored us.
        const looksIgnored = hadTextFilter && mailboxTotal > 0 && total >= Math.max(50, Math.floor(mailboxTotal * 0.9));
        if (looksIgnored) usedClientFilter = true;
      }

      if (usedClientFilter) {
        const dateOnly = {};
        if (unreadOnly) dateOnly.seen = false;
        else dateOnly.all = true;
        if (since) dateOnly.since = since;
        if (before) dateOnly.before = before;
        const dateUids = await client.search(dateOnly, { uid: true });
        uids = Array.isArray(dateUids) ? dateUids : [];
        total = uids.length;
      }

      const sorted = _uidsSortedDesc(uids);
      // When we'll filter client-side we may need to fetch many to find a few.
      // Cap at 5000 envelopes per folder to bound work. Lower the cap when
      // preview is requested, because each fetch also pulls the message
      // source — pulling 5000 full bodies would be huge and slow.
      const clientCap = previewChars > 0 ? 500 : 5000;
      const fetchCap = usedClientFilter ? Math.min(clientCap, sorted.length) : Math.min(perAccountFetchLimit, sorted.length);
      const slice = sorted.slice(0, fetchCap);

      const qLower = q.toLowerCase();
      const fromLower = fromQ.toLowerCase();
      const subjLower = subjQ.toLowerCase();
      const matchesClient = (env) => {
        if (!usedClientFilter) return true;
        const subj = String(env.subject || "");
        const fromAddr = firstAddress(env.from) || "";
        if (fromLower && !fromAddr.toLowerCase().includes(fromLower)) return false;
        if (subjLower && !subj.toLowerCase().includes(subjLower)) return false;
        if (qLower) {
          const hay = (subj + " " + fromAddr).toLowerCase();
          if (!hay.includes(qLower)) return false;
        }
        return true;
      };

      const emails = [];
      let matched = 0;
      const wantPreview = previewChars > 0;
      if (slice.length > 0) {
        for await (const msg of client.fetch(
          slice,
          { envelope: true, flags: true, internalDate: true, bodyStructure: true, source: wantPreview },
          { uid: true }
        )) {
          const env = msg.envelope || {};
          if (!matchesClient(env)) continue;
          matched += 1;
          if (emails.length >= perAccountFetchLimit) continue;
          const flags = msg.flags || new Set([]);
          const unread = !flags.has("\\Seen");
          const item = {
            id: String(msg.uid),
            uid: String(msg.uid),
            gid: `${acc.id}:${msg.uid}`,
            subject: env.subject || "",
            from: firstAddress(env.from),
            to: firstAddress(env.to),
            date: formatDateTime(msg.internalDate || env.date),
            unread,
            flagged: flags.has("\\Flagged"),
            is_flagged: flags.has("\\Flagged"),
            has_attachments: hasAttachmentsFromBodyStructure(msg.bodyStructure),
            message_id: env.messageId || "",
            account: acc.email,
            account_id: acc.id,
            folder: folderPath,
            preview: "",
          };
          if (wantPreview && msg.source) {
            try {
              // eslint-disable-next-line no-await-in-loop
              const parsed = await _safeParse(msg.source);
              const txt = String(parsed.text || "").replace(/\s+/g, " ").trim();
              item.preview = txt.slice(0, previewChars);
              if (txt.length > previewChars) item.preview_truncated = true;
            } catch {
              // ignore preview parse failures
            }
          }
          emails.push(item);
        }
      }
      const totalReported = usedClientFilter ? matched : total;
      const out = { total_found: totalReported, emails };
      if (usedClientFilter) out.client_filter = { fetched: slice.length, mailbox_total: mailboxTotal };
      return out;
    } finally {
      lock.release();
    }
  }

  for (const acc of targets) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await withImapClient(acc, async (client) => {
        const folderPaths = scanAll
          ? _selectableFoldersFor(await _listMailboxes(client))
          : [openFolder];
        if (folderPaths.length === 0) folderPaths.push("INBOX");

        let totalCombined = 0;
        const emailsCombined = [];
        const folderErrors = [];
        for (const fp of folderPaths) {
          try {
            // eslint-disable-next-line no-await-in-loop
            const part = await _searchOneFolder(client, acc, fp);
            totalCombined += part.total_found;
            emailsCombined.push(...part.emails);
          } catch (fe) {
            folderErrors.push({ folder: fp, error: fe && fe.message ? fe.message : "search failed" });
          }
        }

        const out = { success: true, total_found: totalCombined, emails: emailsCombined };
        if (folderErrors.length) out.folder_errors = folderErrors;
        return out;
      });
      perAccount.push({ account: acc, ...r });
    } catch (e) {
      failed_accounts.push({ account: acc.email || "", account_id: acc.id || "", error: e && e.message ? e.message : "search failed" });
      perAccount.push({ account: acc, success: false, error: e && e.message ? e.message : "search failed", total_found: 0, emails: [] });
    }
  }

  const allEmails = perAccount.flatMap((r) => (r && r.success ? r.emails || [] : []));
  allEmails.sort((a, b) => _compareDatesDesc(a.date, b.date));

  const page = allEmails.slice(off, off + lim);
  const total_found = perAccount.reduce((sum, r) => sum + Number((r && r.total_found) || 0), 0);
  const accounts_count = targets.length;
  const search_time = (Date.now() - started) / 1000;

  return {
    success: failed_accounts.length === 0,
    emails: page,
    total_found,
    displayed: page.length,
    accounts_count,
    offset: off,
    limit: lim,
    total_emails: page.length,
    accounts_searched: accounts_count,
    accounts_info: [],
    search_time,
    search_params: { query: q, date_from, date_to, unread_only: unreadOnly, folder },
    failed_accounts,
    failed_searches: [],
    partial_success: failed_accounts.length > 0,
  };
}

function _stripUrls(text) {
  return String(text || "").replace(/https?:\/\/\S+/gi, "[link]");
}

async function showEmail({
  email_id,
  folder = "INBOX",
  account_id = "",
  body_max_len = 0,
  html_max_len = 0,
  include_html = true,
  strip_urls = false,
} = {}) {
  const id = String(email_id || "").trim();
  if (!id) return { success: false, error: "Missing email_id" };

  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;

  const openFolder = _normalizeFolder(folder);
  return withImapClient(acc.account, async (client) => {
    await client.mailboxOpen(openFolder);
    const msg = await client.fetchOne(
      Number(id),
      {
        envelope: true,
        flags: true,
        internalDate: true,
        bodyStructure: true,
        source: true,
      },
      { uid: true }
    );
    if (!msg) return { success: false, error: `Email not found: ${id}` };

    if (_isTestMode()) {
      const { getMailbox } = require("../testing/mock_store");
      const mb = getMailbox(acc.account.id, openFolder);
      const raw = mb && mb.messages ? mb.messages.find((m) => String(m.uid) === String(id)) : null;
      if (!raw) return { success: false, error: `Email not found: ${id}` };
      const attachments = (raw.attachments || []).map((a) => ({
        filename: a.filename,
        size: a.content ? a.content.length : 0,
        content_type: a.contentType || "application/octet-stream",
      }));
      const unread = !(raw.flags || new Set([])).has("\\Seen");
      const bodyText = String(raw.body || "");
      const htmlText = String(raw.html || "");
      const bodyBase = strip_urls ? _stripUrls(bodyText) : bodyText;
      const bodyMax = Math.max(0, Number(body_max_len || 0));
      const htmlMax = Math.max(0, Number(html_max_len || 0));
      const includeHtml = include_html !== false;
      let bodyOut = bodyBase;
      let htmlOut = htmlText;
      let bodyTruncated = false;
      let htmlTruncated = false;
      if (bodyMax > 0 && bodyOut.length > bodyMax) {
        bodyOut = bodyOut.slice(0, bodyMax);
        bodyTruncated = true;
      }
      if (includeHtml && htmlMax > 0 && htmlOut.length > htmlMax) {
        htmlOut = htmlOut.slice(0, htmlMax);
        htmlTruncated = true;
      }
      if (!includeHtml) htmlOut = "";
      return {
        success: true,
        id: String(raw.uid),
        gid: `${acc.account.id}:${raw.uid}`,
        requested_id: String(id),
        from: raw.from,
        to: raw.to,
        cc: raw.cc || "",
        subject: raw.subject,
        date: raw.date,
        body: bodyOut,
        html_body: htmlOut,
        has_html: Boolean(raw.html),
        html_included: includeHtml,
        body_url_stripped: Boolean(strip_urls),
        attachments,
        attachment_count: attachments.length,
        unread,
        message_id: raw.messageId || "",
        in_reply_to: raw.inReplyTo || "",
        references: raw.references || "",
        folder: openFolder,
        account: acc.account.email,
        account_id: acc.account.id,
        from_cache: false,
        body_length: bodyText.length,
        html_length: htmlText.length,
        body_truncated: bodyTruncated,
        html_truncated: htmlTruncated,
      };
    }

    const parsed = await _safeParse(msg.source);
    const flags = msg.flags || new Set([]);
    const unread = !flags.has("\\Seen");

    const attachments = (parsed.attachments || []).map((a) => ({
      filename: a.filename || "",
      size: a.size || 0,
      content_type: a.contentType || "application/octet-stream",
    }));

    const bodyText = String(parsed.text || "");
    const htmlText = typeof parsed.html === "string" ? parsed.html : "";
    const bodyBase = strip_urls ? _stripUrls(bodyText) : bodyText;
    const bodyMax = Math.max(0, Number(body_max_len || 0));
    const htmlMax = Math.max(0, Number(html_max_len || 0));
    const includeHtml = include_html !== false;
    let bodyOut = bodyBase;
    let htmlOut = htmlText;
    let bodyTruncated = false;
    let htmlTruncated = false;
    if (bodyMax > 0 && bodyOut.length > bodyMax) {
      bodyOut = bodyOut.slice(0, bodyMax);
      bodyTruncated = true;
    }
    if (includeHtml && htmlMax > 0 && htmlOut.length > htmlMax) {
      htmlOut = htmlOut.slice(0, htmlMax);
      htmlTruncated = true;
    }
    if (!includeHtml) htmlOut = "";

    return {
      success: true,
      id: String(msg.uid),
      gid: `${acc.account.id}:${msg.uid}`,
      requested_id: String(id),
      from: parsed.from ? parsed.from.text || "" : firstAddress(msg.envelope && msg.envelope.from),
      to: parsed.to ? parsed.to.text || "" : firstAddress(msg.envelope && msg.envelope.to),
      cc: parsed.cc ? parsed.cc.text || "" : "",
      subject: parsed.subject || (msg.envelope ? msg.envelope.subject : ""),
      date: formatDateTime(parsed.date || msg.internalDate),
      body: bodyOut,
      html_body: htmlOut,
      has_html: Boolean(parsed.html),
      html_included: includeHtml,
      body_url_stripped: Boolean(strip_urls),
      attachments,
      attachment_count: attachments.length,
      unread,
      message_id: parsed.messageId || (msg.envelope ? msg.envelope.messageId : ""),
      in_reply_to: parsed.inReplyTo || "",
      references: Array.isArray(parsed.references)
        ? parsed.references.join(" ")
        : (parsed.references || ""),
      folder: openFolder,
      account: acc.account.email,
      account_id: acc.account.id,
      from_cache: false,
      body_length: bodyText.length,
      html_length: htmlText.length,
      body_truncated: bodyTruncated,
      html_truncated: htmlTruncated,
    };
  });
}

// Batch fetch multiple emails over a single IMAP connection. Same per-email
// shape as showEmail (minus a few duplicated fields), wrapped in a list.
async function showEmails({
  email_ids,
  folder = "INBOX",
  account_id = "",
  body_max_len = 0,
  html_max_len = 0,
  include_html = true,
  strip_urls = false,
} = {}) {
  const ids = (email_ids || []).map((x) => String(x).trim()).filter(Boolean);
  if (!ids.length) return { success: false, error: "Missing email_ids" };

  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;

  const openFolder = _normalizeFolder(folder);
  const bodyMax = Math.max(0, Number(body_max_len || 0));
  const htmlMax = Math.max(0, Number(html_max_len || 0));
  const includeHtml = include_html !== false;

  return withImapClient(acc.account, async (client) => {
    await client.mailboxOpen(openFolder);
    const emails = [];
    const failed_ids = [];
    for (const id of ids) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const msg = await client.fetchOne(
          Number(id),
          { envelope: true, flags: true, internalDate: true, bodyStructure: true, source: true },
          { uid: true }
        );
        if (!msg) {
          failed_ids.push({ id, error: "not_found" });
          continue;
        }
        // eslint-disable-next-line no-await-in-loop
        const parsed = await _safeParse(msg.source);
        const flags = msg.flags || new Set([]);
        const attachments = (parsed.attachments || []).map((a) => ({
          filename: a.filename || "",
          size: a.size || 0,
          content_type: a.contentType || "application/octet-stream",
        }));
        const bodyText = String(parsed.text || "");
        const htmlText = typeof parsed.html === "string" ? parsed.html : "";
        const bodyBase = strip_urls ? _stripUrls(bodyText) : bodyText;
        let bodyOut = bodyBase;
        let htmlOut = htmlText;
        let bodyTruncated = false;
        let htmlTruncated = false;
        if (bodyMax > 0 && bodyOut.length > bodyMax) {
          bodyOut = bodyOut.slice(0, bodyMax);
          bodyTruncated = true;
        }
        if (includeHtml && htmlMax > 0 && htmlOut.length > htmlMax) {
          htmlOut = htmlOut.slice(0, htmlMax);
          htmlTruncated = true;
        }
        if (!includeHtml) htmlOut = "";
        emails.push({
          id: String(msg.uid),
          gid: `${acc.account.id}:${msg.uid}`,
          from: parsed.from ? parsed.from.text || "" : firstAddress(msg.envelope && msg.envelope.from),
          to: parsed.to ? parsed.to.text || "" : firstAddress(msg.envelope && msg.envelope.to),
          cc: parsed.cc ? parsed.cc.text || "" : "",
          subject: parsed.subject || (msg.envelope ? msg.envelope.subject : ""),
          date: formatDateTime(parsed.date || msg.internalDate),
          body: bodyOut,
          html_body: htmlOut,
          has_html: Boolean(parsed.html),
          html_included: includeHtml,
          body_url_stripped: Boolean(strip_urls),
          attachments,
          attachment_count: attachments.length,
          unread: !flags.has("\\Seen"),
          message_id: parsed.messageId || (msg.envelope ? msg.envelope.messageId : ""),
          in_reply_to: parsed.inReplyTo || "",
          references: Array.isArray(parsed.references) ? parsed.references.join(" ") : (parsed.references || ""),
          body_length: bodyText.length,
          html_length: htmlText.length,
          body_truncated: bodyTruncated,
          html_truncated: htmlTruncated,
        });
      } catch (e) {
        failed_ids.push({ id, error: e && e.message ? e.message : "fetch failed" });
      }
    }
    return {
      success: failed_ids.length === 0,
      emails,
      failed_ids,
      requested: ids.length,
      returned: emails.length,
      folder: openFolder,
      account_id: acc.account.id,
    };
  });
}

async function markEmails({ email_ids, mark_as, folder = "INBOX", account_id = "", dry_run = false } = {}) {
  const ids = (email_ids || []).map((x) => String(x));
  if (!ids.length) return { success: false, error: "Missing email_ids" };
  const markAs = String(mark_as || "").toLowerCase();
  if (markAs !== "read" && markAs !== "unread") return { success: false, error: "Invalid mark_as" };

  if (dry_run) {
    return {
      success: true,
      dry_run: true,
      would_mark: ids.length,
      mark_as: markAs,
      email_ids: ids,
      message: `Dry run: would mark ${ids.length} emails as ${markAs}`,
    };
  }

  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;
  const openFolder = _normalizeFolder(folder);

  return withImapClient(acc.account, async (client) => {
    await client.mailboxOpen(openFolder);
    const uids = ids.map((x) => Number(x));
    const results = [];
    for (const uid of uids) {
      try {
        // eslint-disable-next-line no-await-in-loop
        if (markAs === "read") await client.messageFlagsAdd(uid, ["\\Seen"], { uid: true });
        else await client.messageFlagsRemove(uid, ["\\Seen"], { uid: true });
        results.push({ success: true, email_id: String(uid), folder: openFolder, account_id: acc.account.id });
      } catch (e) {
        results.push({ success: false, email_id: String(uid), folder: openFolder, account_id: acc.account.id, error: e && e.message ? e.message : "failed" });
      }
    }
    const marked = results.filter((r) => r.success).length;
    return {
      success: marked === results.length,
      marked_count: marked,
      total: results.length,
      total_requested: results.length,
      mark_as: markAs,
      results,
    };
  });
}

async function _findTrashFolder(client, preferredName) {
  const pref = String(preferredName || "").trim();
  const listResult = await client.list();
  const iterate = listResult && typeof listResult[Symbol.asyncIterator] === "function"
    ? listResult
    : Array.isArray(listResult)
      ? listResult
      : [];

  let exactMatch = "";
  let bySpecialUse = "";
  for await (const mb of iterate) {
    const pathName = mb.path || mb.name || "";
    if (!pathName) continue;
    const special = String(mb.specialUse || "");
    if (special === "\\Trash") {
      bySpecialUse = pathName;
      // \Trash is authoritative; stop searching as soon as we find it.
      break;
    }
    if (pref && pathName === pref) exactMatch = pathName;
  }

  if (bySpecialUse) return bySpecialUse;
  if (exactMatch) return exactMatch;
  // No \Trash special-use and no exact preferred-name match: fail loudly so
  // we don't silently fall through to a non-existent "Trash" folder, which
  // would error out per UID inside messageMove anyway.
  throw new Error(
    pref
      ? `Trash folder not found: server has no \\Trash special-use mailbox and "${pref}" does not exist. Pass --trash-folder <name> or use --permanent.`
      : "Trash folder not found: server has no \\Trash special-use mailbox. Pass --trash-folder <name> or use --permanent."
  );
}

async function deleteEmails({ email_ids, folder = "INBOX", permanent = false, trash_folder = "Trash", account_id = "", dry_run = false } = {}) {
  const ids = (email_ids || []).map((x) => String(x));
  if (!ids.length) return { success: false, error: "Missing email_ids" };

  if (dry_run) {
    return {
      success: true,
      dry_run: true,
      would_delete: ids.length,
      permanent: Boolean(permanent),
      email_ids: ids,
      message: `Dry run: would ${permanent ? "delete" : "move to trash"} ${ids.length} emails`,
    };
  }

  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;
  const openFolder = _normalizeFolder(folder);

  return withImapClient(acc.account, async (client) => {
    await client.mailboxOpen(openFolder);
    const uids = ids.map((x) => Number(x));
    const results = [];

    let trashName = "";
    if (!permanent) {
      try {
        trashName = await _findTrashFolder(client, trash_folder);
      } catch (e) {
        return { success: false, error: e && e.message ? e.message : "Trash folder lookup failed" };
      }
    }

    for (const uid of uids) {
      try {
        // eslint-disable-next-line no-await-in-loop
        if (permanent) await client.messageDelete(uid, { uid: true });
        else await client.messageMove(uid, trashName, { uid: true });
        results.push({ success: true, email_id: String(uid), folder: openFolder, account_id: acc.account.id });
      } catch (e) {
        results.push({ success: false, email_id: String(uid), folder: openFolder, account_id: acc.account.id, error: e && e.message ? e.message : "failed" });
      }
    }
    const deleted = results.filter((r) => r.success).length;
    return {
      success: deleted === results.length,
      deleted_count: deleted,
      total: results.length,
      total_requested: results.length,
      results,
    };
  });
}

async function sendEmail({ to, subject, body, cc, bcc, account_id = "", is_html = false } = {}) {
  const tos = Array.isArray(to) ? to : [to];
  const recipients = tos.map((x) => String(x)).filter((x) => x.trim());
  if (!recipients.length) return { success: false, error: "Missing --to" };
  const subj = String(subject || "");
  if (!subj.trim()) return { success: false, error: "Missing --subject" };

  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;

  try {
    const r = await sendMail({
      account: acc.account,
      to: recipients.join(", "),
      cc: Array.isArray(cc) ? cc.join(", ") : cc || "",
      bcc: Array.isArray(bcc) ? bcc.join(", ") : bcc || "",
      subject: subj,
      text: is_html ? "" : String(body || ""),
      html: is_html ? String(body || "") : "",
    });

    if (!r.success) return r;
    return {
      success: true,
      message: `Email sent successfully to ${recipients.length} recipient(s)`,
      recipients,
      from: acc.account.email,
    };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : "send failed", from: acc.account.email };
  }
}

// Common reply-prefix forms across locales. Matches "Re:", "RE：", "回复:",
// "答复:", "Sv:", "Antwort:", "AW:", "RES:", "Tr:" with optional whitespace.
const _REPLY_PREFIX_RE = /^\s*(re|aw|antwort|sv|res|回复|答复|回覆|tr)\s*[:：]/i;

function _splitAddressList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function _addressEmail(addr) {
  const m = String(addr).match(/<([^>]+)>/);
  return (m ? m[1] : String(addr)).trim().toLowerCase();
}

function _dedupeAddresses(list, exclude) {
  const excluded = new Set((exclude || []).map((x) => String(x).toLowerCase()));
  const seen = new Set();
  const out = [];
  for (const addr of list) {
    const key = _addressEmail(addr);
    if (!key || excluded.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

function _buildReferences(detail) {
  const refs = [];
  const existing = detail.references ? String(detail.references).trim() : "";
  if (existing) refs.push(existing);
  const parent = detail.message_id ? String(detail.message_id).trim() : "";
  if (parent && !refs.join(" ").includes(parent)) refs.push(parent);
  return refs.join(" ").trim();
}

async function replyEmail({ email_id, body, reply_all = false, folder = "INBOX", account_id = "", is_html = false } = {}) {
  const detail = await showEmail({ email_id, folder, account_id });
  if (!detail.success) return detail;
  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;

  const fromAddr = detail.from || "";
  let toList = [fromAddr].filter(Boolean);
  let ccList = [];
  if (reply_all) {
    const origTo = _splitAddressList(detail.to);
    const origCc = _splitAddressList(detail.cc);
    toList = _dedupeAddresses([fromAddr, ...origTo], [acc.account.email]);
    ccList = _dedupeAddresses(origCc, [acc.account.email, ..._dedupeAddresses(toList).map(_addressEmail)]);
  }
  if (!toList.length) {
    return { success: false, error: "Reply has no recipient (original sender unknown)", from: acc.account.email };
  }

  const subjectRaw = detail.subject || "";
  const subject = _REPLY_PREFIX_RE.test(subjectRaw) ? subjectRaw : `Re: ${subjectRaw}`;
  const headers = {};
  if (detail.message_id) headers["In-Reply-To"] = detail.message_id;
  const refs = _buildReferences(detail);
  if (refs) headers.References = refs;

  try {
    await sendMail({
      account: acc.account,
      to: toList.join(", "),
      cc: ccList.length ? ccList.join(", ") : undefined,
      subject,
      text: is_html ? "" : String(body || ""),
      html: is_html ? String(body || "") : "",
      headers,
    });
    return {
      success: true,
      message: "Reply sent successfully",
      recipients: toList,
      cc: ccList,
      from: acc.account.email,
    };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : "reply failed", from: acc.account.email };
  }
}

async function forwardEmail({ email_id, to, body = "", folder = "INBOX", no_attachments = false, account_id = "" } = {}) {
  const detail = await showEmail({ email_id, folder, account_id });
  if (!detail.success) return detail;
  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;

  const recipients = (Array.isArray(to) ? to : [to]).map((x) => String(x)).filter((x) => x.trim());
  if (!recipients.length) return { success: false, error: "Missing --to" };

  let attachments = [];
  if (!no_attachments && detail.attachment_count) {
    if (_isTestMode()) {
      const { getMailbox } = require("../testing/mock_store");
      const mb = getMailbox(acc.account.id, _normalizeFolder(folder));
      const raw = mb && mb.messages ? mb.messages.find((m) => String(m.uid) === String(email_id)) : null;
      attachments = (raw && raw.attachments ? raw.attachments : []).map((a) => ({
        filename: path.basename(String(a.filename || "attachment")),
        content: a.content,
        contentType: a.contentType,
      }));
    } else {
      // Re-fetch the source so we can attach the original parts. Without this
      // --no-attachments would be a no-op vs. always-drop, which is misleading.
      const fetched = await withImapClient(acc.account, async (client) => {
        await client.mailboxOpen(_normalizeFolder(folder));
        const uid = Number(email_id);
        if (!Number.isFinite(uid)) return null;
        return client.fetchOne(uid, { source: true }, { uid: true });
      });
      if (fetched && fetched.source) {
        const parsed = await _safeParse(fetched.source);
        let totalBytes = 0;
        for (const a of parsed.attachments || []) {
          if (!a.content || !a.content.length) continue;
          if (a.content.length > MAX_ATTACHMENT_BYTES) continue;
          totalBytes += a.content.length;
          if (totalBytes > MAX_ATTACHMENTS_TOTAL) break;
          attachments.push({
            filename: path.basename(String(a.filename || "attachment")),
            content: a.content,
            contentType: a.contentType || "application/octet-stream",
          });
        }
      }
    }
  }

  try {
    await sendMail({
      account: acc.account,
      to: recipients.join(", "),
      subject: `Fwd: ${detail.subject || ""}`,
      text: String(body || ""),
      attachments,
    });
    return {
      success: true,
      message: `Email sent successfully to ${recipients.length} recipient(s)`,
      recipients,
      from: acc.account.email,
    };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : "forward failed", from: acc.account.email };
  }
}

async function listFolders({ account_id } = {}) {
  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;

  return withImapClient(acc.account, async (client) => {
    const folders = [];
    for (const mb of await _listMailboxes(client)) {
      folders.push({
        name: mb.name || mb.path || "",
        attributes: Array.isArray(mb.flags) ? mb.flags.join(" ") : "",
        delimiter: mb.delimiter || "/",
        message_count: 0,
        path: mb.path || mb.name || "",
      });
    }
    return {
      success: true,
      folders,
      folder_tree: {},
      total_folders: folders.length,
      account: acc.account.email,
    };
  });
}

async function downloadAttachments({ email_id, folder = "INBOX", account_id, output_dir = "" } = {}) {
  const detail = await showEmail({ email_id, folder, account_id });
  if (!detail.success) return detail;

  const targetDir = output_dir ? String(output_dir) : paths.getPathConfig().attachmentsDir;
  fs.mkdirSync(targetDir, { recursive: true });

  // Pick a non-conflicting filename inside targetDir, basename-only to defeat
  // path traversal from attacker-supplied filenames.
  const _pickDest = (rawName) => {
    const filename = path.basename(String(rawName || "attachment"));
    if (!filename) return { filename: "", dest: "" };
    let dest = path.join(targetDir, filename);
    const ext = path.extname(filename);
    const base = ext ? filename.slice(0, -ext.length) : filename;
    let counter = 1;
    while (fs.existsSync(dest)) {
      dest = path.join(targetDir, `${base}_${counter}${ext}`);
      counter += 1;
    }
    return { filename, dest };
  };

  if (_isTestMode()) {
    const acc = accounts.getAccountByIdOrEmail(account_id);
    if (!acc.success) return acc;
    const { getMailbox } = require("../testing/mock_store");
    const mb = getMailbox(acc.account.id, _normalizeFolder(folder));
    const raw = mb && mb.messages ? mb.messages.find((m) => String(m.uid) === String(email_id)) : null;
    const attachments = [];
    let totalBytes = 0;
    for (const a of raw && raw.attachments ? raw.attachments : []) {
      const content = a.content;
      if (!content || !content.length) continue;
      if (content.length > MAX_ATTACHMENT_BYTES) {
        return { success: false, error: `Attachment "${a.filename}" exceeds ${MAX_ATTACHMENT_BYTES} bytes` };
      }
      totalBytes += content.length;
      if (totalBytes > MAX_ATTACHMENTS_TOTAL) {
        return { success: false, error: `Attachments exceed total cap of ${MAX_ATTACHMENTS_TOTAL} bytes` };
      }
      const { filename, dest } = _pickDest(a.filename);
      if (!filename) continue;
      fs.writeFileSync(dest, content);
      attachments.push({
        filename,
        size: content.length,
        size_formatted: formatSize(content.length),
        content_type: a.contentType,
        saved_path: dest,
      });
    }
    return {
      success: true,
      attachments,
      attachment_count: attachments.length,
      email_id: String(email_id),
      folder: _normalizeFolder(folder),
      account: acc.account.email,
    };
  }

  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;

  const openFolder = _normalizeFolder(folder);
  const uid = Number(email_id);
  if (!Number.isFinite(uid)) return { success: false, error: "Invalid email_id" };

  return withImapClient(acc.account, async (client) => {
    await client.mailboxOpen(openFolder);
    const msg = await client.fetchOne(uid, { source: true, envelope: true }, { uid: true });
    if (!msg || !msg.source) return { success: false, error: `Email not found: ${email_id}` };

    const parsed = await _safeParse(msg.source);

    const attachments = [];
    let totalBytes = 0;
    for (const a of parsed.attachments || []) {
      const content = a.content;
      if (!content || !content.length) continue;
      if (content.length > MAX_ATTACHMENT_BYTES) {
        return { success: false, error: `Attachment "${a.filename || "(unnamed)"}" exceeds ${MAX_ATTACHMENT_BYTES} bytes` };
      }
      totalBytes += content.length;
      if (totalBytes > MAX_ATTACHMENTS_TOTAL) {
        return { success: false, error: `Attachments exceed total cap of ${MAX_ATTACHMENTS_TOTAL} bytes` };
      }
      const { filename, dest } = _pickDest(a.filename);
      if (!filename) continue;
      fs.writeFileSync(dest, content);

      attachments.push({
        filename,
        size: content.length,
        size_formatted: formatSize(content.length),
        content_type: a.contentType || "application/octet-stream",
        saved_path: dest,
      });
    }

    return {
      success: true,
      attachments,
      attachment_count: attachments.length,
      email_id: String(email_id),
      folder: openFolder,
      account: acc.account.email,
    };
  });
}

// Map user-facing flag_type to IMAP keyword. Unknown values fall through as
// custom keywords (which any IMAP server may accept or reject) so we don't
// silently coerce them into \Flagged.
const _FLAG_MAP = {
  flagged: "\\Flagged",
  starred: "\\Flagged",
  important: "$Important",
  read: "\\Seen",
  seen: "\\Seen",
  answered: "\\Answered",
  draft: "\\Draft",
  junk: "$Junk",
  spam: "$Junk",
  notjunk: "$NotJunk",
  forwarded: "$Forwarded",
};

async function flagEmail({ email_id, set_flag, flag_type = "flagged", folder = "INBOX", account_id } = {}) {
  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;
  const openFolder = _normalizeFolder(folder);
  const uid = Number(email_id);
  if (!Number.isFinite(uid)) return { success: false, error: "Invalid email_id" };

  const flagType = String(flag_type || "flagged").toLowerCase();
  const flag = _FLAG_MAP[flagType] || flagType;
  const set = Boolean(set_flag);

  return withImapClient(acc.account, async (client) => {
    await client.mailboxOpen(openFolder);
    if (set) await client.messageFlagsAdd(uid, [flag], { uid: true });
    else await client.messageFlagsRemove(uid, [flag], { uid: true });
    return {
      success: true,
      message: `Flag "${flagType}" ${set ? "set" : "unset"}`,
      email_id: String(uid),
      flag_type: flagType,
      set_flag: set,
      folder: openFolder,
      account: acc.account.email,
    };
  });
}

async function moveEmails({ email_ids, target_folder, source_folder = "INBOX", account_id } = {}) {
  const ids = (email_ids || []).map((x) => Number(x)).filter((n) => Number.isFinite(n));
  if (!ids.length) return { success: false, error: "Missing email_ids" };
  const tgt = String(target_folder || "").trim();
  if (!tgt) return { success: false, error: "Missing --target-folder" };
  const src = _normalizeFolder(source_folder);

  const acc = accounts.getAccountByIdOrEmail(account_id);
  if (!acc.success) return acc;

  return withImapClient(acc.account, async (client) => {
    await client.mailboxOpen(src);
    const failed_ids = [];
    let moved = 0;
    for (const uid of ids) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await client.messageMove(uid, tgt, { uid: true });
        moved += 1;
      } catch {
        failed_ids.push(String(uid));
      }
    }
    return {
      success: failed_ids.length === 0,
      message: `Moved ${moved}/${ids.length} emails to "${tgt}"`,
      moved_count: moved,
      source_folder: src,
      target_folder: tgt,
      account: acc.account.email,
      failed_ids,
    };
  });
}

module.exports = {
  listEmails,
  searchEmails,
  showEmail,
  showEmails,
  markEmails,
  deleteEmails,
  sendEmail,
  replyEmail,
  forwardEmail,
  listFolders,
  downloadAttachments,
  flagEmail,
  moveEmails,
};

const fs = require("fs");
const path = require("path");
const { Command } = require("commander");

const { contract } = require("@mailbox/shared");
const { accounts, email, imap, smtp, sync } = require("@mailbox/core");
const { digest, monitor, inbox } = require("@mailbox/workflows");

function _printTextNotImplemented(label) {
  // Goes to stderr so it never corrupts a JSON pipe consumer.
  process.stderr.write(`${label} (text mode) is not implemented yet. Use --json.\n`);
}

const MAX_BODY_FILE_BYTES = Number(process.env.MAILBOX_MAX_BODY_FILE_BYTES || 10 * 1024 * 1024); // 10 MiB

// Hard upper bound on per-call result limits. Without this, a typo like
// --limit 99999999 would happily try to fetch the entire mailbox (and
// trigger IMAP rate limits / OOM). Override via env if you really need it.
const MAX_RESULT_LIMIT = Number(process.env.MAILBOX_MAX_LIMIT || 1000);

// Validate --limit/--offset. Returns { ok, limit, offset, error }.
function _validatePaging(limitRaw, offsetRaw, { defaultLimit }) {
  const limit = limitRaw == null || limitRaw === "" ? defaultLimit : Number(limitRaw);
  const offset = offsetRaw == null || offsetRaw === "" ? 0 : Number(offsetRaw);
  if (!Number.isFinite(limit) || limit < 0) {
    return { ok: false, error: `--limit must be a non-negative number (got ${limitRaw})` };
  }
  if (!Number.isFinite(offset) || offset < 0) {
    return { ok: false, error: `--offset must be a non-negative number (got ${offsetRaw})` };
  }
  if (limit > MAX_RESULT_LIMIT) {
    return { ok: false, error: `--limit ${limit} exceeds MAILBOX_MAX_LIMIT=${MAX_RESULT_LIMIT}; raise the env var if intentional` };
  }
  return { ok: true, limit, offset };
}

// Validate a date string the same way _parseDateInput in core/email.js does.
// We only reject if the user supplied something unparseable — empty is fine.
function _validateDateOpt(name, raw) {
  const value = String(raw || "").trim();
  if (!value) return { ok: true };
  // YYYY-MM-DD shortcut accepted by core
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T00:00:00`);
    if (!Number.isNaN(d.getTime())) return { ok: true };
  }
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return { ok: true };
  return { ok: false, error: `${name} value "${value}" is not a valid date (expected YYYY-MM-DD or ISO 8601)` };
}

function _readBodyFile(bodyFilePath) {
  const st = fs.statSync(bodyFilePath);
  if (st.size > MAX_BODY_FILE_BYTES) {
    throw new Error(`--body-file exceeds ${MAX_BODY_FILE_BYTES} bytes (size=${st.size})`);
  }
  return fs.readFileSync(bodyFilePath, "utf8");
}

// Cooperative shutdown for foreground daemons. SIGINT/SIGTERM flips the flag
// and resolves any in-flight wait so the loop can finish its current pass
// (e.g. mid-flush sqlite write) before exiting.
function _createStopSignal() {
  const state = { stopped: false, wakers: new Set() };
  const trigger = () => {
    state.stopped = true;
    for (const w of state.wakers) {
      try { w(); } catch { /* ignore */ }
    }
    state.wakers.clear();
  };
  process.once("SIGINT", trigger);
  process.once("SIGTERM", trigger);
  return {
    stopped: () => state.stopped,
    sleep(ms) {
      if (state.stopped) return Promise.resolve();
      return new Promise((resolve) => {
        const t = setTimeout(() => {
          state.wakers.delete(resolve);
          resolve();
        }, ms);
        const wake = () => { clearTimeout(t); resolve(); };
        state.wakers.add(wake);
      });
    },
  };
}

function _resolveCliVersion() {
  const env = process.env.MAILBOX_CLI_VERSION || process.env.MAILBOX_VERSION || "";
  if (env && typeof env === "string" && env.trim()) return env.trim();

  const candidates = [
    path.join(__dirname, "..", "package.json"),
    path.join(__dirname, "..", "..", "package.json"),
    path.join(process.cwd(), "package.json"),
  ];

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const raw = fs.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw);
      const version = parsed && parsed.version ? String(parsed.version).trim() : "";
      if (version) return version;
    } catch {
      // ignore
    }
  }

  return "0.0.0";
}

async function main(argv) {
  const parsed = contract.parseGlobalFlags(argv);
  let asJson = parsed.asJson;
  const pretty = parsed.pretty;
  if (!asJson && !process.stdout.isTTY) asJson = true;

  const program = new Command();
  program.name("mailbox");
  program.version(_resolveCliVersion(), "-v, --version", "output the version");
  program.exitOverride();
  // Suppress commander's default "error: ..." stderr line — we surface the
  // same message via the JSON contract (or via invalidUsage on stderr) and
  // don't want the message to appear twice (once raw, once wrapped in JSON).
  program.configureOutput({
    writeErr: () => {},
  });

  const accountCmd = program.command("account").description("Account operations");
  accountCmd
    .command("list")
    .description("List configured accounts")
    .action(() => {
      const result = accounts.listAccounts();
      const rc = contract.handleJsonOrText({
        result,
        asJson,
        pretty,
        printText: (r) => {
          const rows = r.accounts || [];
          if (!rows.length) {
            process.stdout.write("No accounts configured.\n");
            return;
          }
          process.stdout.write("ID\tEmail\tProvider\n");
          for (const a of rows) {
            process.stdout.write(`${a.id}\t${a.email || ""}\t${a.provider || ""}\n`);
          }
        },
      });
      process.exit(rc);
    });

  accountCmd
    .command("test-connection")
    .description("Test IMAP/SMTP connectivity")
    .option("--account-id <id>", "Specific account id/email")
    .action(async (opts) => {
      let result;

      try {
        const accId = String(opts.accountId || "").trim();
        let targets = [];

        if (accId) {
          const one = accounts.getAccountByIdOrEmail(accId);
          if (!one.success) {
            result = { success: false, error: one.error || `Account not found: ${accId}`, accounts: [], total_accounts: 0 };
          } else {
            targets = [one.account];
          }
        } else {
          const all = accounts.getAllAccountsResolved();
          if (!all.success) {
            result = all;
          } else {
            targets = all.accounts || [];
            if (!targets.length) {
              result = { success: false, error: "No accounts configured", accounts: [], total_accounts: 0 };
            }
          }
        }

        if (!result) {
          const out = [];
          for (const a of targets) {
            const item = {
              email: a.email,
              provider: a.provider,
              success: false,
              imap: { success: false },
              smtp: { success: false },
            };

            try {
              // eslint-disable-next-line no-await-in-loop
              const im = await imap.testConnection(a, "INBOX");
              item.imap = { success: Boolean(im && im.success), total_emails: im.total_emails || 0, unread_emails: im.unread_emails || 0 };
              if (im && im.error) item.imap.error = im.error;
            } catch (e) {
              item.imap = { success: false, error: e && e.message ? e.message : "IMAP failed" };
            }

            try {
              // eslint-disable-next-line no-await-in-loop
              const sm = await smtp.testConnection(a);
              item.smtp = { success: Boolean(sm && sm.success) };
              if (sm && sm.error) item.smtp.error = sm.error;
            } catch (e) {
              item.smtp = { success: false, error: e && e.message ? e.message : "SMTP failed" };
            }

            item.success = Boolean(item.imap && item.imap.success) && Boolean(item.smtp && item.smtp.success);
            out.push(item);
          }

          result = { success: out.length > 0 && out.every((x) => x.success), accounts: out, total_accounts: out.length };
        }
      } catch (e) {
        result = { success: false, error: e && e.message ? e.message : "test failed" };
      }

      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("account test-connection") });
      process.exit(rc);
    });

  // email
  const emailCmd = program.command("email").description("Email operations");
  emailCmd
    .command("list")
    .description("List emails")
    .option("--limit <n>", "Limit", "100")
    .option("--offset <n>", "Offset", "0")
    .option("--unread-only", "Only unread")
    .option("--account-id <id>", "Account id/email")
    .option("--date-from <s>", "Filter from date (YYYY-MM-DD or ISO)")
    .option("--date-to <s>", "Filter to date (YYYY-MM-DD or ISO)")
    .option("--folder <name>", "Folder (currently only INBOX is supported here; use 'email search' for cross-folder)", "INBOX")
    .option("--live", "Force live IMAP (no cache)")
    .action(async (opts) => {
      const paging = _validatePaging(opts.limit, opts.offset, { defaultLimit: 100 });
      if (!paging.ok) {
        const rc = contract.invalidUsage({ message: paging.error, asJson, pretty });
        process.exit(rc);
      }
      for (const [name, val] of [["--date-from", opts.dateFrom], ["--date-to", opts.dateTo]]) {
        const v = _validateDateOpt(name, val);
        if (!v.ok) {
          const rc = contract.invalidUsage({ message: v.error, asJson, pretty });
          process.exit(rc);
        }
      }
      const result = await email.listEmails({
        limit: paging.limit,
        offset: paging.offset,
        unread_only: Boolean(opts.unreadOnly),
        folder: opts.folder,
        account_id: opts.accountId || "",
        date_from: opts.dateFrom || "",
        date_to: opts.dateTo || "",
        use_cache: !Boolean(opts.live),
      });
      // Add contract parity fields.
      result.limit = paging.limit;
      result.offset = paging.offset;
      result.unread_only = Boolean(opts.unreadOnly);
      result.folder = opts.folder;
      result.use_cache = !Boolean(opts.live);
      if (opts.dateFrom) result.date_from = opts.dateFrom;
      if (opts.dateTo) result.date_to = opts.dateTo;
      if (opts.accountId) result.account_id = opts.accountId;

      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email list") });
      process.exit(rc);
    });

  emailCmd
    .command("search")
    .description("Search emails")
    .option("--query <q>", "Free-text query (IMAP TEXT, matches body+headers)")
    .option("--from <s>", "Filter by sender (IMAP FROM, substring match)")
    .option("--subject <s>", "Filter by subject (IMAP SUBJECT, substring match)")
    .option("--account-id <id>")
    .option("--date-from <s>")
    .option("--date-to <s>")
    .option("--limit <n>", "Limit", "50")
    .option("--offset <n>", "Offset", "0")
    .option("--unread-only")
    .option("--folder <name>", "Folder", "all")
    .action(async (opts) => {
      if (!opts.query && !opts.from && !opts.subject && !opts.dateFrom && !opts.dateTo && !opts.unreadOnly) {
        const rc = contract.invalidUsage({
          message: "Provide at least one of --query, --from, --subject, --date-from, --date-to, --unread-only",
          asJson,
          pretty,
        });
        process.exit(rc);
      }
      const paging = _validatePaging(opts.limit, opts.offset, { defaultLimit: 50 });
      if (!paging.ok) {
        const rc = contract.invalidUsage({ message: paging.error, asJson, pretty });
        process.exit(rc);
      }
      for (const [name, val] of [["--date-from", opts.dateFrom], ["--date-to", opts.dateTo]]) {
        const v = _validateDateOpt(name, val);
        if (!v.ok) {
          const rc = contract.invalidUsage({ message: v.error, asJson, pretty });
          process.exit(rc);
        }
      }
      const result = await email.searchEmails({
        query: opts.query || "",
        from: opts.from || "",
        subject: opts.subject || "",
        account_id: opts.accountId || "",
        date_from: opts.dateFrom || "",
        date_to: opts.dateTo || "",
        limit: paging.limit,
        offset: paging.offset,
        unread_only: Boolean(opts.unreadOnly),
        folder: opts.folder,
      });
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email search") });
      process.exit(rc);
    });

  emailCmd
    .command("show")
    .description("Show email detail")
    .argument("<email_id>")
    .option("--account-id <id>")
    .option("--folder <name>", "Folder", "INBOX")
    .option("--preview", "Return a short body preview")
    .option("--body-max-len <n>", "Max body length (characters)")
    .option("--html-max-len <n>", "Max HTML length (characters)")
    .option("--no-html", "Exclude HTML body")
    .option("--strip-urls", "Remove URLs from body text")
    .action(async (emailId, opts) => {
      const bodyMaxRaw = opts.bodyMaxLen != null ? Number(opts.bodyMaxLen) : null;
      const htmlMaxRaw = opts.htmlMaxLen != null ? Number(opts.htmlMaxLen) : null;
      let bodyMax = Number.isFinite(bodyMaxRaw) ? Math.max(0, bodyMaxRaw) : 0;
      let htmlMax = Number.isFinite(htmlMaxRaw) ? Math.max(0, htmlMaxRaw) : 0;
      if (opts.preview) {
        if (!bodyMax) bodyMax = 400;
        if (!htmlMax && opts.html !== false) htmlMax = 2000;
      }
      const result = await email.showEmail({
        email_id: emailId,
        folder: opts.folder,
        account_id: opts.accountId || "",
        body_max_len: bodyMax,
        html_max_len: htmlMax,
        include_html: opts.html !== false,
        strip_urls: Boolean(opts.stripUrls),
      });
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email show") });
      process.exit(rc);
    });

  emailCmd
    .command("mark")
    .description("Mark emails read/unread")
    .argument("<email_ids...>")
    .option("--read", "Mark as read")
    .option("--unread", "Mark as unread")
    .option("--account-id <id>")
    .option("--folder <name>", "Folder", "INBOX")
    .option("--confirm", "Apply changes (default: dry-run)")
    .option("--dry-run")
    .action(async (ids, opts) => {
      const read = Boolean(opts.read);
      const unread = Boolean(opts.unread);
      if ((read && unread) || (!read && !unread)) {
        const rc = contract.invalidUsage({ message: "Specify exactly one of --read/--unread", asJson, pretty });
        process.exit(rc);
      }

      const dryRun = Boolean(opts.dryRun) || !Boolean(opts.confirm);
      const mark_as = unread ? "unread" : "read";
      const result = await email.markEmails({
        email_ids: ids,
        mark_as,
        folder: opts.folder,
        account_id: opts.accountId || "",
        dry_run: dryRun,
      });
      if (dryRun && !opts.dryRun && result && typeof result === "object") {
        result.confirmation_required = true;
        result.confirmation_hint = "Re-run with --confirm to apply changes";
      }
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email mark") });
      process.exit(rc);
    });

  emailCmd
    .command("delete")
    .description("Delete emails")
    .argument("<email_ids...>")
    .option("--account-id <id>")
    .option("--folder <name>", "Folder", "INBOX")
    .option("--permanent")
    .option("--trash-folder <name>", "Trash folder", "Trash")
    .option("--confirm", "Apply changes (default: dry-run)")
    .option("--dry-run")
    .action(async (ids, opts) => {
      const dryRun = Boolean(opts.dryRun) || !Boolean(opts.confirm);
      const result = await email.deleteEmails({
        email_ids: ids,
        folder: opts.folder,
        permanent: Boolean(opts.permanent),
        trash_folder: opts.trashFolder,
        account_id: opts.accountId || "",
        dry_run: dryRun,
      });
      if (dryRun && !opts.dryRun && result && typeof result === "object") {
        result.confirmation_required = true;
        result.confirmation_hint = "Re-run with --confirm to apply changes";
      }
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email delete") });
      process.exit(rc);
    });

  emailCmd
    .command("send")
    .description("Send an email")
    .requiredOption("--to <to...>")
    .requiredOption("--subject <s>")
    .option("--body <text>")
    .option("--body-file <path>")
    .option("--cc <cc...>")
    .option("--bcc <bcc...>")
    .option("--account-id <id>")
    .option("--is-html")
    .option("--confirm", "Actually send (default: dry-run)")
    .option("--dry-run")
    .action(async (opts) => {
      const hasBody = typeof opts.body === "string" && opts.body.length;
      const hasBodyFile = Boolean(opts.bodyFile);
      if ((hasBody && hasBodyFile) || (!hasBody && !hasBodyFile)) {
        const rc = contract.invalidUsage({ message: "Specify exactly one of --body/--body-file", asJson, pretty });
        process.exit(rc);
      }

      let body = opts.body || "";
      if (opts.bodyFile) {
        try {
          body = _readBodyFile(opts.bodyFile);
        } catch (e) {
          const rc = contract.invalidUsage({ message: e && e.message ? e.message : "Failed to read body file", asJson, pretty });
          process.exit(rc);
        }
      }
      const dryRun = Boolean(opts.dryRun) || !Boolean(opts.confirm);
      if (dryRun) {
        const result = {
          success: true,
          dry_run: true,
          would_send: {
            to: opts.to,
            cc: opts.cc || [],
            bcc: opts.bcc || [],
            subject: opts.subject,
            account_id: opts.accountId || "",
            is_html: Boolean(opts.isHtml),
            body_bytes: Buffer.byteLength(body, "utf8"),
            body_preview: body.slice(0, 200),
          },
          confirmation_required: true,
          confirmation_hint: "Re-run with --confirm to actually send",
        };
        const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email send") });
        process.exit(rc);
      }
      const result = await email.sendEmail({
        to: opts.to,
        subject: opts.subject,
        body,
        cc: opts.cc,
        bcc: opts.bcc,
        account_id: opts.accountId || "",
        is_html: Boolean(opts.isHtml),
      });
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email send") });
      process.exit(rc);
    });

  emailCmd
    .command("reply")
    .description("Reply to an email")
    .argument("<email_id>")
    .option("--body <text>")
    .option("--body-file <path>")
    .option("--reply-all")
    .option("--folder <name>", "Folder", "INBOX")
    .option("--account-id <id>")
    .option("--is-html")
    .action(async (emailId, opts) => {
      const hasBody = typeof opts.body === "string" && opts.body.length;
      const hasBodyFile = Boolean(opts.bodyFile);
      if ((hasBody && hasBodyFile) || (!hasBody && !hasBodyFile)) {
        const rc = contract.invalidUsage({ message: "Specify exactly one of --body/--body-file", asJson, pretty });
        process.exit(rc);
      }

      let body = opts.body || "";
      if (opts.bodyFile) {
        try {
          body = _readBodyFile(opts.bodyFile);
        } catch (e) {
          const rc = contract.invalidUsage({ message: e && e.message ? e.message : "Failed to read body file", asJson, pretty });
          process.exit(rc);
        }
      }
      const result = await email.replyEmail({
        email_id: emailId,
        body,
        reply_all: Boolean(opts.replyAll),
        folder: opts.folder,
        account_id: opts.accountId || "",
        is_html: Boolean(opts.isHtml),
      });
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email reply") });
      process.exit(rc);
    });

  emailCmd
    .command("forward")
    .description("Forward an email")
    .argument("<email_id>")
    .requiredOption("--to <to...>")
    .option("--body <text>")
    .option("--folder <name>", "Folder", "INBOX")
    .option("--no-attachments")
    .option("--account-id <id>")
    .action(async (emailId, opts) => {
      const result = await email.forwardEmail({
        email_id: emailId,
        to: opts.to,
        body: opts.body || "",
        folder: opts.folder,
        no_attachments: Boolean(opts.noAttachments),
        account_id: opts.accountId || "",
      });
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email forward") });
      process.exit(rc);
    });

  emailCmd
    .command("folders")
    .description("List folders")
    .requiredOption("--account-id <id>")
    .action(async (opts) => {
      const result = await email.listFolders({ account_id: opts.accountId });
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email folders") });
      process.exit(rc);
    });

  emailCmd
    .command("attachments")
    .description("Download attachments")
    .argument("<email_id>")
    .requiredOption("--account-id <id>")
    .option("--folder <name>", "Folder", "INBOX")
    .action(async (emailId, opts) => {
      const result = await email.downloadAttachments({ email_id: emailId, folder: opts.folder, account_id: opts.accountId });
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email attachments") });
      process.exit(rc);
    });

  emailCmd
    .command("flag")
    .description("Flag/unflag an email")
    .argument("<email_id>")
    .requiredOption("--account-id <id>")
    .option("--set")
    .option("--unset")
    .option("--flag-type <t>", "Flag type", "flagged")
    .option("--folder <name>", "Folder", "INBOX")
    .option("--confirm", "Apply changes (default: dry-run)")
    .option("--dry-run")
    .action(async (emailId, opts) => {
      const set = Boolean(opts.set);
      const unset = Boolean(opts.unset);
      if ((set && unset) || (!set && !unset)) {
        const rc = contract.invalidUsage({ message: "Specify exactly one of --set/--unset", asJson, pretty });
        process.exit(rc);
      }

      const setFlag = set;
      const dryRun = Boolean(opts.dryRun) || !Boolean(opts.confirm);
      const result = await email.flagEmail({
        email_id: emailId,
        set_flag: setFlag,
        flag_type: opts.flagType,
        folder: opts.folder,
        account_id: opts.accountId,
        dry_run: dryRun,
      });
      if (dryRun && !opts.dryRun && result && typeof result === "object") {
        result.confirmation_required = true;
        result.confirmation_hint = "Re-run with --confirm to apply changes";
      }
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email flag") });
      process.exit(rc);
    });

  emailCmd
    .command("move")
    .description("Move emails to folder")
    .argument("<email_ids...>")
    .requiredOption("--target-folder <name>")
    .option("--source-folder <name>", "Source folder", "INBOX")
    .requiredOption("--account-id <id>")
    .option("--confirm", "Apply changes (default: dry-run)")
    .option("--dry-run")
    .action(async (ids, opts) => {
      const dryRun = Boolean(opts.dryRun) || !Boolean(opts.confirm);
      const result = await email.moveEmails({
        email_ids: ids,
        target_folder: opts.targetFolder,
        source_folder: opts.sourceFolder,
        account_id: opts.accountId,
        dry_run: dryRun,
      });
      if (dryRun && !opts.dryRun && result && typeof result === "object") {
        result.confirmation_required = true;
        result.confirmation_hint = "Re-run with --confirm to apply changes";
      }
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("email move") });
      process.exit(rc);
    });

  // sync
  const syncCmd = program.command("sync").description("Local sync/cache operations");
  syncCmd
    .command("status")
    .description("Show scheduler status")
    .action(() => {
      const result = sync.status();
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("sync status") });
      process.exit(rc);
    });
  syncCmd
    .command("force")
    .description("Force sync now")
    .option("--account-id <id>")
    .option("--full")
    .action(async (opts) => {
      const result = await sync.force({ account_id: opts.accountId || "", full: Boolean(opts.full) });
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("sync force") });
      process.exit(rc);
    });
  syncCmd
    .command("init")
    .description("Initialize database and run initial sync")
    .action(async () => {
      const result = await sync.init();
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("sync init") });
      process.exit(rc);
    });
  syncCmd
    .command("health")
    .description("Show sync health summary")
    .action(() => {
      const result = sync.health();
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("sync health") });
      process.exit(rc);
    });

  syncCmd
    .command("watch")
    .description("Continuously print sync status")
    .option("--interval <seconds>", "Refresh interval", "5")
    .action(async (opts) => {
      const { printJson } = require("@mailbox/shared").json;
      const intervalSec = Math.max(0.5, Number(opts.interval || 5));
      const stop = _createStopSignal();
      try {
        while (!stop.stopped()) {
          const status = sync.status();
          status.success = true;
          printJson(status, Boolean(pretty) || !asJson);
          // eslint-disable-next-line no-await-in-loop
          await stop.sleep(intervalSec * 1000);
        }
        return process.exit(0);
      } catch (e) {
        if (e && e.name === "AbortError") return process.exit(0);
        return process.exit(0);
      }
    });

  syncCmd
    .command("daemon")
    .description("Run periodic sync in the foreground")
    .option("--interval <seconds>", "Sync interval", "300")
    .option("--account-id <id>")
    .option("--full")
    .action(async (opts) => {
      const intervalSec = Math.max(5, Number(opts.interval || 300));
      const stop = _createStopSignal();
      try {
        while (!stop.stopped()) {
          // eslint-disable-next-line no-await-in-loop
          await sync.force({ account_id: opts.accountId || "", full: Boolean(opts.full) });
          if (stop.stopped()) break;
          // eslint-disable-next-line no-await-in-loop
          await stop.sleep(intervalSec * 1000);
        }
        return process.exit(0);
      } catch {
        return process.exit(0);
      }
    });

  // digest
  const digestCmd = program.command("digest").description("Daily digest workflows");
  digestCmd
    .command("run")
    .description("Run once")
    .option("--dry-run")
    .option("--debug-path <path>")
    .action(async (opts) => {
      const result = await digest.run({ dry_run: Boolean(opts.dryRun), debug_path: opts.debugPath || "" });
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("digest run") });
      process.exit(rc);
    });
  digestCmd
    .command("config")
    .description("Print current configuration")
    .action(() => {
      const result = digest.getConfig();
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("digest config") });
      process.exit(rc);
    });

  digestCmd
    .command("daemon")
    .description("Run digest periodically in the foreground")
    .option("--interval <seconds>", "Interval", "3600")
    .option("--dry-run")
    .action(async (opts) => {
      const intervalSec = Math.max(5, Number(opts.interval || 3600));
      const stop = _createStopSignal();
      try {
        while (!stop.stopped()) {
          // eslint-disable-next-line no-await-in-loop
          await digest.run({ dry_run: Boolean(opts.dryRun), debug_path: "" });
          if (stop.stopped()) break;
          // eslint-disable-next-line no-await-in-loop
          await stop.sleep(intervalSec * 1000);
        }
        return process.exit(0);
      } catch {
        return process.exit(0);
      }
    });

  // monitor
  const monitorCmd = program.command("monitor").description("Email monitor workflows");
  monitorCmd
    .command("run")
    .description("Run one monitoring cycle")
    .action(async () => {
      const result = await monitor.run();
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("monitor run") });
      process.exit(rc);
    });
  monitorCmd
    .command("status")
    .description("Get monitoring status")
    .action(() => {
      const result = monitor.status();
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("monitor status") });
      process.exit(rc);
    });
  monitorCmd
    .command("config")
    .description("Print current configuration")
    .action(() => {
      const result = monitor.config();
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("monitor config") });
      process.exit(rc);
    });
  monitorCmd
    .command("test")
    .description("Test individual components")
    .argument("[component]", "fetch|notify|all", "all")
    .action((component) => {
      const result = monitor.test({ component });
      const rc = contract.handleJsonOrText({ result, asJson, pretty, printText: () => _printTextNotImplemented("monitor test") });
      process.exit(rc);
    });

  // inbox
  program
    .command("inbox")
    .description("Inbox organizer")
    .option("--limit <n>", "Analyze latest N emails", "15")
    .option("--folder <name>", "Folder", "INBOX")
    .option("--unread-only")
    .option("--account-id <id>")
    .option("--text")
    .action(async (opts) => {
      const result = await inbox.run({
        limit: Number(opts.limit),
        folder: opts.folder,
        unread_only: Boolean(opts.unreadOnly),
        account_id: opts.accountId || "",
      });
      const rc = contract.handleJsonOrText({
        result,
        asJson,
        pretty,
        printText: (r) => {
          if (opts.text && r && r.summary_text) process.stdout.write(String(r.summary_text) + "\n");
          else _printTextNotImplemented("inbox");
        },
      });
      process.exit(rc);
    });

  // Default interactive mode if no command.
  if (!parsed.argv.length) {
    return contract.invalidUsage({ message: "No command provided", asJson, pretty });
  }

  try {
    await program.parseAsync(["node", "mailbox", ...parsed.argv]);
    return 0;
  } catch (err) {
    if (
      err &&
      (err.code === "commander.help" ||
        err.code === "commander.helpDisplayed" ||
        err.code === "commander.version") &&
      err.exitCode === 0
    ) {
      return 0;
    }
    // commander throws on invalid usage (exitOverride).
    let message = err && err.message ? err.message : "Invalid usage";
    // Strip commander's own "error: " prefix so the JSON payload doesn't
    // end up with `"error": "error: ..."`.
    message = String(message).replace(/^error:\s*/i, "");
    return contract.invalidUsage({ message, asJson, pretty });
  }
}

module.exports = { main };

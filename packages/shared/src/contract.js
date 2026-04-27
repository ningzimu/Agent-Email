const { printJson } = require("./json");

function parseGlobalFlags(argv) {
  const rest = [];
  let asJson = false;
  let pretty = false;
  let forceText = false;
  let lean = false;

  for (const arg of argv) {
    if (arg === "--json") {
      asJson = true;
      continue;
    }
    if (arg === "--pretty") {
      pretty = true;
      continue;
    }
    if (arg === "--text") {
      forceText = true;
      continue;
    }
    if (arg === "--lean") {
      lean = true;
      continue;
    }
    rest.push(arg);
  }

  return { asJson, pretty, forceText, lean, argv: rest };
}

// Fields that are noise for an AI consumer of the JSON contract — they
// either restate the request, are empty most of the time, or duplicate
// info that's already present elsewhere. --lean strips them.
const LEAN_DROP_TOP_LEVEL = new Set([
  "accounts_info",
  "accounts_count",
  "accounts_searched",
  "search_time",
  "search_params",
  "failed_searches",
  "partial_success",
  "from_cache",
  "use_cache",
  "unread_only",
  "folder",
  "account_id",
  "date_from",
  "date_to",
  "limit",
  "offset",
  "total_emails",
  "total_unread",
  "fetched_raw",
  "displayed",
]);
const LEAN_DROP_PER_EMAIL = new Set([
  "uid",
  "to",
  "flagged",
  "account",
  "source",
  "is_flagged",
  "preview",
]);

function leanResult(result) {
  if (!result || typeof result !== "object") return result;
  const out = {};
  for (const [k, v] of Object.entries(result)) {
    if (LEAN_DROP_TOP_LEVEL.has(k)) continue;
    // Drop empty arrays / objects to save tokens.
    if (Array.isArray(v) && v.length === 0 && k !== "emails" && k !== "accounts") continue;
    if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    out[k] = v;
  }
  if (Array.isArray(out.emails)) {
    out.emails = out.emails.map((e) => {
      if (!e || typeof e !== "object") return e;
      const slim = {};
      for (const [k, v] of Object.entries(e)) {
        if (LEAN_DROP_PER_EMAIL.has(k)) continue;
        if (k === "preview" && !v) continue;
        slim[k] = v;
      }
      return slim;
    });
  }
  return out;
}

// Infer a stable, machine-readable error_code from a free-text error
// message. Lets the JSON contract include both a human string (`error`)
// and an enum (`error_code`) without rewriting every internal call site.
const ERROR_CODE_RULES = [
  [/^Account not found/i, "account_not_found"],
  [/^Email not found/i, "email_not_found"],
  [/^Mailbox not found|^Folder not found|does not exist/i, "folder_not_found"],
  [/^Provide at least one of|^Missing |^Specify exactly one|^Invalid /i, "invalid_argument"],
  [/is not a valid date/i, "invalid_date"],
  [/must be a non-negative number|exceeds MAILBOX_MAX_LIMIT/i, "invalid_limit"],
  [/^Mixed account_ids/i, "ambiguous_account"],
  [/exceeds MAILBOX_MAX_BODY_FILE_BYTES|exceeds MAILBOX_MAX_MESSAGE_BYTES/i, "size_limit"],
  [/AUTHENTICATIONFAILED|Invalid credentials|535[\s-]/i, "auth_failed"],
  [/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|getaddrinfo/i, "network_error"],
  [/SMTP|Greylisted|Mail rejected/i, "smtp_error"],
  [/IMAP|search failed|fetch failed|client\.list/i, "imap_error"],
];
function inferErrorCode(message) {
  const m = String(message || "");
  if (!m) return "unknown_error";
  for (const [re, code] of ERROR_CODE_RULES) if (re.test(m)) return code;
  return "operation_failed";
}

function ensureSuccessField(result) {
  if (!result || typeof result !== "object") return { success: false, error: "Invalid result", error_code: "invalid_result" };
  if (typeof result.success !== "boolean") result.success = !result.error;
  if (!result.success && result.error && !result.error_code) {
    result.error_code = inferErrorCode(result.error);
  }
  return result;
}

function exitCodeForResult(result) {
  const r = ensureSuccessField(result);
  return r.success ? 0 : 1;
}

function handleJsonOrText({ result, asJson, pretty, lean, printText }) {
  let normalized = ensureSuccessField(result);
  if (lean) normalized = leanResult(normalized);

  if (asJson) {
    printJson(normalized, pretty);
  } else if (typeof printText === "function") {
    printText(normalized);
  } else {
    // Default: print JSON even when not requested (debug-friendly).
    printJson(normalized, true);
  }

  return exitCodeForResult(normalized);
}

function invalidUsage({ message, asJson, pretty }) {
  const msg = message || "Invalid usage";
  const payload = { success: false, error: msg, error_code: inferErrorCode(msg) || "invalid_argument" };
  // inferErrorCode falls back to "operation_failed" when nothing matches —
  // for the invalid-usage entry point we still want "invalid_argument".
  if (payload.error_code === "operation_failed" || payload.error_code === "unknown_error") {
    payload.error_code = "invalid_argument";
  }
  if (asJson) {
    printJson(payload, pretty);
  } else {
    process.stderr.write((payload.error || "Invalid usage") + "\n");
  }
  return 2;
}

module.exports = {
  parseGlobalFlags,
  ensureSuccessField,
  exitCodeForResult,
  handleJsonOrText,
  invalidUsage,
  inferErrorCode,
  leanResult,
};

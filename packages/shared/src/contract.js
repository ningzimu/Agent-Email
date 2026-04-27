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

function ensureSuccessField(result) {
  if (!result || typeof result !== "object") return { success: false, error: "Invalid result" };
  if (typeof result.success === "boolean") return result;
  result.success = !result.error;
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
  const payload = { success: false, error: message || "Invalid usage" };
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
  leanResult,
};

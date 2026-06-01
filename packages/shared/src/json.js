const fs = require("fs");

function safeJsonStringify(value, pretty) {
  return JSON.stringify(value, null, pretty ? 2 : 0);
}

function printJson(value, pretty) {
  // Use fs.writeSync so the payload is fully flushed before any subsequent
  // process.exit(). process.stdout is async on pipes, which truncated large
  // JSON outputs (e.g. email search results > ~64KB) at exit time.
  const buf = Buffer.from(safeJsonStringify(value, pretty) + "\n");
  let offset = 0;
  while (offset < buf.length) {
    try {
      offset += fs.writeSync(1, buf, offset, buf.length - offset);
    } catch (e) {
      if (e && (e.code === "EAGAIN" || e.code === "EWOULDBLOCK")) continue;
      if (e && e.code === "EPIPE") return;
      throw e;
    }
  }
}

// Write a list of records as JSON Lines (one compact JSON object per line).
// Uses the same blocking-write strategy as printJson to survive process.exit().
function printJsonl(records) {
  const list = Array.isArray(records) ? records : [records];
  const text = list.map((r) => JSON.stringify(r)).join("\n") + (list.length ? "\n" : "");
  const buf = Buffer.from(text);
  let offset = 0;
  while (offset < buf.length) {
    try {
      offset += fs.writeSync(1, buf, offset, buf.length - offset);
    } catch (e) {
      if (e && (e.code === "EAGAIN" || e.code === "EWOULDBLOCK")) continue;
      if (e && e.code === "EPIPE") return;
      throw e;
    }
  }
}

module.exports = {
  printJson,
  printJsonl,
  safeJsonStringify,
};

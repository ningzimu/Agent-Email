const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_BYTES = Number(process.env.MAILBOX_MAX_CLOUD_ATTACHMENT_BYTES || 1024 * 1024 * 1024);

function decodeHtmlEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'");
}

function redactToken(value) {
  const s = String(value || "");
  if (s.length <= 10) return s ? "***" : "";
  return `${s.slice(0, 6)}...${s.slice(-4)}`;
}

function safeFilename(rawName, fallback = "cloud-attachment") {
  const base = path.basename(String(rawName || fallback)).replace(/[\0\r\n]/g, "").trim();
  return base || fallback;
}

function pickDest({ outputDir, outputPath = "", filename, force = false }) {
  const targetDir = outputPath ? path.dirname(outputPath) : outputDir;
  fs.mkdirSync(targetDir, { recursive: true });
  if (outputPath) {
    const dest = path.resolve(outputPath);
    if (!force && fs.existsSync(dest)) {
      throw Object.assign(new Error(`File already exists: ${dest}`), { code: "file_exists" });
    }
    return { filename: path.basename(dest), dest };
  }

  const clean = safeFilename(filename);
  const ext = path.extname(clean);
  const stem = ext ? clean.slice(0, -ext.length) : clean;
  let dest = path.join(targetDir, clean);
  let counter = 1;
  while (!force && fs.existsSync(dest)) {
    dest = path.join(targetDir, `${stem}_${counter}${ext}`);
    counter += 1;
  }
  return { filename: path.basename(dest), dest };
}

function withTimeout(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  if (typeof timer.unref === "function") timer.unref();
  return { signal: ctrl.signal, done: () => clearTimeout(timer) };
}

function assertCloudSize(size, maxBytes = DEFAULT_MAX_BYTES) {
  if (size == null || size === "") return;
  const n = Number(size);
  if (Number.isFinite(n) && n > maxBytes) {
    throw Object.assign(new Error(`Cloud attachment exceeds ${maxBytes} bytes`), { code: "size_limit" });
  }
}

function extractNetEaseUrls(text) {
  const decoded = decodeHtmlEntities(text);
  const found = new Set();
  const re = /https:\/\/dashi\.163\.com\/html\/cloud-attachment-download\/\?[^"' <>\n\r]+/gi;
  for (const m of decoded.matchAll(re)) found.add(m[0]);
  return [...found];
}

function extractQqFtnUrls(text) {
  const decoded = decodeHtmlEntities(text);
  const found = new Set();
  const re = /https:\/\/wx\.mail\.qq\.com\/ftn\/download\?[^"' <>\n\r]+/gi;
  for (const m of decoded.matchAll(re)) found.add(m[0]);
  return [...found];
}

function extractCloudAttachmentSources(text) {
  return [
    ...extractQqFtnUrls(text).map((url) => ({ provider: "qq-ftn", url })),
    ...extractNetEaseUrls(text).map((url) => ({ provider: "netease-cloud", url })),
  ];
}

function parseNetEaseKey(source) {
  const u = new URL(decodeHtmlEntities(source));
  const key = u.searchParams.get("key");
  if (!key) throw Object.assign(new Error("Missing NetEase cloud attachment key"), { code: "invalid_argument" });
  return key;
}

async function fetchJson(fetchImpl, url, options = {}) {
  const res = await fetchImpl(url, options);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw Object.assign(new Error(`Invalid JSON response from ${new URL(url).host}`), { code: "network_error" });
  }
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} from ${new URL(url).host}`), { code: "network_error", data });
  return data;
}

async function fetchNetEaseMetadata(url, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof fetchImpl !== "function") throw Object.assign(new Error("fetch is not available"), { code: "operation_failed" });
  const key = parseNetEaseKey(url);
  const timer = withTimeout(timeoutMs);
  try {
    const infoUrl = `https://dashi.163.com/filehub-master/file/link/info/get?fid=&key=${encodeURIComponent(key)}`;
    const info = await fetchJson(fetchImpl, infoUrl, { method: "GET", signal: timer.signal });
    const body = info && (info.result || info.data || info.body || info);
    return { key, raw: info, body };
  } finally {
    timer.done();
  }
}

function netEaseFileFromMetadata(meta) {
  const body = meta && meta.body ? meta.body : {};
  const file = body.file || body.fileInfo || body;
  return {
    name: file.name || file.fileName || file.filename || body.name || body.fileName || "netease-cloud-attachment",
    size: file.size || file.fileSize || body.size || body.fileSize || null,
    fid: file.fid || body.fid || "",
  };
}

async function prepareNetEaseDownload(key, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const timer = withTimeout(timeoutMs);
  try {
    const res = await fetchJson(fetchImpl, "https://dashi.163.com/filehub-master/file/dl/prepare2", {
      method: "POST",
      signal: timer.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fid: "", linkKey: key }),
    });
    const body = res && (res.result || res.data || res.body || res);
    const downloadUrl = body.downloadUrl || body.url || body.download_url;
    if (!downloadUrl) throw Object.assign(new Error("NetEase response did not include downloadUrl"), { code: "operation_failed", data: res });
    return { raw: res, body, downloadUrl };
  } finally {
    timer.done();
  }
}

async function downloadToFile(fetchImpl, url, dest, { timeoutMs = DEFAULT_TIMEOUT_MS, maxBytes = DEFAULT_MAX_BYTES, headers = {} } = {}) {
  const timer = withTimeout(timeoutMs);
  const tmp = `${dest}.part-${process.pid}-${Date.now()}`;
  try {
    const res = await fetchImpl(url, { method: "GET", signal: timer.signal, headers });
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status} while downloading ${new URL(url).host}`), { code: "network_error" });
    const contentLength = Number(res.headers.get("content-length") || 0);
    assertCloudSize(contentLength || null, maxBytes);
    const ab = await res.arrayBuffer();
    const buf = Buffer.from(ab);
    assertCloudSize(buf.length, maxBytes);
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, dest);
    return { bytes: buf.length };
  } finally {
    timer.done();
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

async function downloadNetEaseCloudAttachment(url, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch;
  const outputDir = opts.outputDir || process.cwd();
  const timeoutMs = Number(opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  const maxBytes = Number(opts.maxBytes || DEFAULT_MAX_BYTES);
  const meta = await fetchNetEaseMetadata(url, { fetchImpl, timeoutMs });
  const file = netEaseFileFromMetadata(meta);
  assertCloudSize(file.size, maxBytes);
  const prepared = await prepareNetEaseDownload(meta.key, { fetchImpl, timeoutMs });
  const { filename, dest } = pickDest({ outputDir, outputPath: opts.outputPath || "", filename: file.name, force: Boolean(opts.force) });
  const downloaded = await downloadToFile(fetchImpl, prepared.downloadUrl, dest, { timeoutMs, maxBytes });
  return {
    provider: "netease-cloud",
    filename,
    original_filename: file.name,
    size: downloaded.bytes,
    expected_size: file.size == null ? null : Number(file.size),
    saved_path: dest,
    key: redactToken(meta.key),
    source_host: "dashi.163.com",
  };
}

function parseQqFtnParams(source) {
  const u = new URL(decodeHtmlEntities(source));
  const key = u.searchParams.get("key") || u.searchParams.get("k") || "";
  const code = u.searchParams.get("code") || "";
  if (!key) throw Object.assign(new Error("Missing QQ FTN key"), { code: "invalid_argument" });
  return { key, code };
}

async function fetchQqFtnMetadata(source, { fetchImpl = globalThis.fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const { key, code } = parseQqFtnParams(source);
  const timer = withTimeout(timeoutMs);
  try {
    const body = new URLSearchParams({
      f: "json",
      func: "3",
      key,
      code,
      r: String(Math.random()),
    });
    const res = await fetchImpl("https://wx.mail.qq.com/ftn/download", {
      method: "POST",
      signal: timer.signal,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw Object.assign(new Error("Invalid JSON response from QQ FTN"), { code: "network_error" });
    }
    const ret = data.ret != null ? data.ret : data.head && data.head.ret;
    if (!res.ok || ret !== 0) {
      throw Object.assign(new Error(`QQ FTN metadata request failed: ret=${ret}`), { code: "network_error", data });
    }
    const b = data.body || {};
    return {
      key,
      code,
      name: b.name || "qq-large-attachment",
      size: b.size == null ? null : Number(b.size),
      md5: b.md5 || "",
      sha: b.sha || "",
      expired_time: b.expired_time || null,
      raw: data,
    };
  } finally {
    timer.done();
  }
}

function defaultChromePath() {
  return process.env.MAILBOX_CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
}

function md5File(file) {
  const h = crypto.createHash("md5");
  h.update(fs.readFileSync(file));
  return h.digest("hex");
}

async function downloadQqFtnAttachment(source, opts = {}) {
  let chromium;
  try {
    ({ chromium } = require("playwright-core"));
  } catch {
    return {
      success: false,
      error: "QQ large attachment download requires playwright-core. Run pnpm install in the mailbox repo and retry.",
      error_code: "missing_dependency",
      provider: "qq-ftn",
    };
  }

  const timeoutMs = Number(opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  const maxBytes = Number(opts.maxBytes || DEFAULT_MAX_BYTES);
  const outputDir = opts.outputDir || process.cwd();
  const chromePath = opts.chromePath || defaultChromePath();
  let meta = null;
  try {
    meta = await fetchQqFtnMetadata(source, { fetchImpl: opts.fetchImpl || globalThis.fetch, timeoutMs });
    assertCloudSize(meta.size, maxBytes);
  } catch (e) {
    if (opts.strictMetadata) throw e;
  }

  const browser = await chromium.launch({ headless: true, executablePath: chromePath });
  try {
    const ctx = await browser.newContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    page.setDefaultTimeout(timeoutMs);
    await page.goto(decodeHtmlEntities(source), { waitUntil: "networkidle", timeout: timeoutMs });
    const downloadButton = page.locator(".operate-btn").filter({ hasText: "下载" }).last();
    const textFallback = page.locator("text=下载").last();
    const downloadPromise = page.waitForEvent("download", { timeout: timeoutMs });
    if (await downloadButton.count()) await downloadButton.click({ timeout: timeoutMs });
    else await textFallback.click({ timeout: timeoutMs });
    const download = await downloadPromise;
    const suggested = download.suggestedFilename();
    const expectedName = meta && meta.name ? meta.name : suggested;
    const { filename, dest } = pickDest({ outputDir, outputPath: opts.outputPath || "", filename: expectedName, force: Boolean(opts.force) });
    await download.saveAs(dest);
    const stat = fs.statSync(dest);
    assertCloudSize(stat.size, maxBytes);
    const actualMd5 = md5File(dest);
    if (meta && meta.size != null && Number(meta.size) !== stat.size) {
      throw Object.assign(new Error(`QQ FTN size mismatch: expected ${meta.size}, got ${stat.size}`), { code: "operation_failed" });
    }
    if (meta && meta.md5 && meta.md5.toLowerCase() !== actualMd5.toLowerCase()) {
      throw Object.assign(new Error("QQ FTN md5 mismatch"), { code: "operation_failed" });
    }
    const params = parseQqFtnParams(source);
    return {
      provider: "qq-ftn",
      filename,
      original_filename: expectedName,
      size: stat.size,
      expected_size: meta ? meta.size : null,
      md5: actualMd5,
      sha: meta ? meta.sha : "",
      expired_time: meta ? meta.expired_time : null,
      saved_path: dest,
      key: redactToken(params.key),
      source_host: "wx.mail.qq.com",
    };
  } finally {
    await browser.close();
  }
}

async function downloadCloudAttachmentSource(source, opts = {}) {
  const provider = source.provider || "";
  const url = source.url || source;
  if (provider === "qq-ftn" || /wx\.mail\.qq\.com\/ftn\/download/i.test(url)) {
    return downloadQqFtnAttachment(url, opts);
  }
  if (provider === "netease-cloud" || /dashi\.163\.com\/html\/cloud-attachment-download/i.test(url)) {
    return downloadNetEaseCloudAttachment(url, opts);
  }
  return { success: false, error: `Unsupported cloud attachment source: ${url}`, error_code: "invalid_argument" };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  extractCloudAttachmentSources,
  downloadCloudAttachmentSource,
  downloadNetEaseCloudAttachment,
  downloadQqFtnAttachment,
  _test: {
    decodeHtmlEntities,
    extractNetEaseUrls,
    extractQqFtnUrls,
    fetchQqFtnMetadata,
    netEaseFileFromMetadata,
    parseNetEaseKey,
    parseQqFtnParams,
    pickDest,
    prepareNetEaseDownload,
    redactToken,
    safeFilename,
  },
};

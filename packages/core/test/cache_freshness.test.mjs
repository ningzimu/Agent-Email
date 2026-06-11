import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const email = require("../src/services/email.js");
const syncDb = require("../src/storage/sync_db.js");
const { resetMockState } = require("../src/testing/mock_store.js");

function setTestEnv(root) {
  process.env.MAILBOX_INTERNAL_TEST_MODE = "1";
  process.env.MAILBOX_CONFIG_DIR = path.join(root, "config");
  process.env.MAILBOX_DATA_DIR = path.join(root, "data");
  fs.mkdirSync(process.env.MAILBOX_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.MAILBOX_CONFIG_DIR, "auth.json"),
    JSON.stringify({
      version: 1,
      accounts: { mock_acc: { email: "mock@example.com", password: "mock", provider: "mock" } },
      default_account: "mock_acc",
    }) + "\n",
    "utf8"
  );
}

// Seed the cache for mock_acc/INBOX with a controllable lastSync timestamp and
// a controllable set of rows.
async function seedCache({ lastSyncIso, rows = [] }) {
  const dbPath = path.join(process.env.MAILBOX_DATA_DIR, "email_sync.db");
  await syncDb.upsertAccount({ dbPath, id: "mock_acc", email: "mock@example.com", provider: "mock" });
  const { folderId } = await syncDb.upsertFolder({
    dbPath,
    accountId: "mock_acc",
    name: "INBOX",
    displayName: "INBOX",
    messageCount: rows.length,
    unreadCount: rows.filter((r) => r.unread).length,
    lastSyncIso,
  });
  if (rows.length) {
    await syncDb.upsertEmails({ dbPath, accountId: "mock_acc", folderId, emails: rows });
  }
  return dbPath;
}

describe("cache freshness signals + self-heal", () => {
  beforeEach(() => {
    const root = path.join(import.meta.dirname, ".tmp", "cache_freshness");
    fs.rmSync(root, { recursive: true, force: true });
    setTestEnv(root);
    resetMockState();
    delete process.env.MAILBOX_CACHE_FRESH_SECONDS;
  });
  afterEach(() => {
    delete process.env.MAILBOX_CACHE_FRESH_SECONDS;
  });

  it("listEmailsFromCache always carries from_cache + cache_age_seconds, even when empty", async () => {
    // Fresh snapshot, but zero rows match (e.g. nothing synced yet for the scope).
    const dbPath = await seedCache({ lastSyncIso: new Date().toISOString(), rows: [] });
    const r = await syncDb.listEmailsFromCache({ dbPath, accountId: "mock_acc", folder: "INBOX", limit: 8, offset: 0 });
    expect(r.emails.length).toBe(0);
    expect(r.from_cache).toBe(true);
    expect(typeof r.cache_age_seconds).toBe("number");
    expect(r.cache_age_seconds).toBeGreaterThanOrEqual(0);
    expect(r.unread_as_of).toBeTruthy();
  });

  it("fresh thin cache is trusted as-is and carries a hint (no live fallback)", async () => {
    // Fresh snapshot (age ~0s) with a single row, asking for more than exists.
    await seedCache({
      lastSyncIso: new Date().toISOString(),
      rows: [{ uid: "901", subject: "cached only", from: "a@b.com", date: "2026-02-01 00:00:00", unread: false }],
    });
    const r = await email.listEmails({ account_id: "mock_acc", folder: "INBOX", limit: 8, use_cache: true });
    expect(r.from_cache).toBe(true); // trusted, not refetched
    expect(r.emails.length).toBe(1);
    expect(r.emails[0].subject).toBe("cached only");
    // Thin (1 < 8) → machine-readable hint present.
    expect(typeof r.hint).toBe("string");
    expect(r.hint).toMatch(/cache/i);
    expect(r.hint).toMatch(/--live/);
  });

  it("stale + thin cache self-heals to a live IMAP fetch (picks up fresh mail)", async () => {
    // Snapshot is old and the cache holds an email the live mailbox does NOT —
    // a live fallback must replace it with the mock INBOX rows.
    await seedCache({
      lastSyncIso: "2020-01-01T00:00:00.000Z", // ~years old → stale
      rows: [{ uid: "777", subject: "STALE CACHED", from: "old@b.com", date: "2020-01-01 00:00:00", unread: false }],
    });
    const r = await email.listEmails({ account_id: "mock_acc", folder: "INBOX", limit: 8, use_cache: true });
    expect(r.from_cache).toBe(false); // fell through to live
    // Live mock INBOX has its own emails, none of them the stale cached one.
    expect(r.emails.some((e) => e.subject === "STALE CACHED")).toBe(false);
    expect(r.emails.length).toBeGreaterThan(0);
    expect(r.cache_age_seconds).toBeNull(); // live shape
  });

  it("MAILBOX_CACHE_FRESH_SECONDS=0 disables the auto-fallback (cache trusted even when stale)", async () => {
    process.env.MAILBOX_CACHE_FRESH_SECONDS = "0";
    await seedCache({
      lastSyncIso: "2020-01-01T00:00:00.000Z",
      rows: [{ uid: "777", subject: "STALE CACHED", from: "old@b.com", date: "2020-01-01 00:00:00", unread: false }],
    });
    const r = await email.listEmails({ account_id: "mock_acc", folder: "INBOX", limit: 8, use_cache: true });
    expect(r.from_cache).toBe(true); // disabled → no live fallback
    expect(r.emails.some((e) => e.subject === "STALE CACHED")).toBe(true);
  });

  it("a full (not thin) cache result needs no hint", async () => {
    const rows = Array.from({ length: 8 }, (_v, i) => ({
      uid: String(1000 + i),
      subject: `m${i}`,
      from: "a@b.com",
      date: `2026-02-01 0${i}:00:00`,
      unread: false,
    }));
    await seedCache({ lastSyncIso: "2020-01-01T00:00:00.000Z", rows });
    const r = await email.listEmails({ account_id: "mock_acc", folder: "INBOX", limit: 8, use_cache: true });
    // Full result (8 >= limit 8) → trusted, no hint even though stale.
    expect(r.from_cache).toBe(true);
    expect(r.emails.length).toBe(8);
    expect(r.hint).toBeUndefined();
  });
});

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

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

describe("WP-B: unread statistics", () => {
  beforeEach(() => {
    const root = path.join(import.meta.dirname, ".tmp", "wp_b");
    fs.rmSync(root, { recursive: true, force: true });
    setTestEnv(root);
    resetMockState();
  });

  it("live list reports unread_in_result matching the returned rows", async () => {
    // INBOX mock: 101 read, 102 unread.
    const r = await email.listEmails({ account_id: "mock_acc", folder: "INBOX", limit: 50, use_cache: false });
    const unreadRows = r.emails.filter((e) => e.unread).length;
    expect(r.unread_in_result).toBe(unreadRows);
    expect(unreadRows).toBeGreaterThan(0); // 102 is unread → never silently 0
  });

  it("live list exposes folder_unread (server STATUS) and aliases unread_count to it", async () => {
    const r = await email.listEmails({ account_id: "mock_acc", folder: "INBOX", limit: 50, use_cache: false });
    expect(r.folder_unread).toBe(1); // only 102 is unseen in INBOX
    expect(r.unread_count).toBe(r.folder_unread);
    expect(r.from_cache).toBe(false);
  });

  it("account_unread_total is null unless opted in, then sums across folders", async () => {
    const off = await email.listEmails({ account_id: "mock_acc", folder: "INBOX", limit: 50, use_cache: false });
    expect(off.account_unread_total).toBeNull();

    const on = await email.listEmails({
      account_id: "mock_acc",
      folder: "INBOX",
      limit: 50,
      use_cache: false,
      include_account_unread: true,
    });
    expect(on.account_unread_total).toBe(1); // INBOX 1 unread + Trash 0
  });

  it("cache list reports unread_in_result + unread_as_of and does not zero rows", async () => {
    const dbPath = path.join(process.env.MAILBOX_DATA_DIR, "email_sync.db");
    await syncDb.upsertAccount({ dbPath, id: "mock_acc", email: "mock@example.com", provider: "mock" });
    const { folderId } = await syncDb.upsertFolder({
      dbPath,
      accountId: "mock_acc",
      name: "INBOX",
      displayName: "INBOX",
      messageCount: 2,
      unreadCount: 9,
      lastSyncIso: "2026-05-01T00:00:00.000Z",
    });
    await syncDb.upsertEmails({
      dbPath,
      accountId: "mock_acc",
      folderId,
      emails: [
        { uid: "501", subject: "r", from: "a@b.com", date: "2026-02-01 00:00:00", unread: false },
        { uid: "502", subject: "u", from: "a@b.com", date: "2026-02-01 01:00:00", unread: true },
      ],
    });
    const r = await syncDb.listEmailsFromCache({ dbPath, accountId: "mock_acc", folder: "INBOX", limit: 50, offset: 0 });
    expect(r.unread_in_result).toBe(r.emails.filter((e) => e.unread).length);
    expect(r.folder_unread).toBe(9); // server snapshot
    expect(r.unread_as_of).toBe("2026-05-01T00:00:00.000Z");
  });

  it("cross-account folder_unread COALESCEs NULL snapshots instead of dropping siblings", async () => {
    const dbPath = path.join(process.env.MAILBOX_DATA_DIR, "email_sync.db");
    await syncDb.upsertAccount({ dbPath, id: "acc_a", email: "a@example.com", provider: "mock" });
    await syncDb.upsertAccount({ dbPath, id: "acc_b", email: "b@example.com", provider: "mock" });
    await syncDb.upsertFolder({ dbPath, accountId: "acc_a", name: "INBOX", displayName: "INBOX", messageCount: 1, unreadCount: 4, lastSyncIso: "2026-05-01T00:00:00.000Z" });
    // acc_b INBOX has a NULL unread snapshot (e.g. invalidated after a mark).
    await syncDb.upsertFolder({ dbPath, accountId: "acc_b", name: "INBOX", displayName: "INBOX", messageCount: 1, unreadCount: null, lastSyncIso: "2026-05-01T00:00:00.000Z" });
    const r = await syncDb.listEmailsFromCache({ dbPath, accountId: "", folder: "INBOX", limit: 50, offset: 0 });
    // acc_a's 4 must survive; the NULL row must not zero the total.
    expect(r.folder_unread).toBe(4);
  });
});

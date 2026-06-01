import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const email = require("../src/services/email.js");
const syncDb = require("../src/storage/sync_db.js");
const { getMailbox, resetMockState } = require("../src/testing/mock_store.js");

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

function pushToTrash(uid) {
  getMailbox("mock_acc", "Trash").messages.push({
    uid,
    messageId: `<m${uid}@example.com>`,
    subject: "deep in trash",
    from: "old@example.com",
    to: "mock@example.com",
    cc: "",
    date: "2026-01-15 00:00:00",
    flags: new Set(["\\Seen"]),
    body: "trashed body",
    html: "",
    attachments: [],
  });
}

describe("WP-D: folder-aware show + 3-part gid", () => {
  beforeEach(() => {
    const root = path.join(import.meta.dirname, ".tmp", "wp_d");
    fs.rmSync(root, { recursive: true, force: true });
    setTestEnv(root);
    resetMockState();
  });

  it("search --folder all emits a 3-part gid carrying the folder", async () => {
    pushToTrash(401);
    const r = await email.searchEmails({ query: "trashed", account_id: "mock_acc", folder: "all", limit: 50 });
    const row = r.emails.find((e) => String(e.uid) === "401");
    expect(row).toBeTruthy();
    expect(row.folder).toBe("Trash");
    expect(row.gid).toBe("mock_acc:Trash:401");
  });

  it("showEmailsResolved opens the folder carried by each ref (no --folder needed)", async () => {
    pushToTrash(402);
    const r = await email.showEmailsResolved({
      refs: [{ id: "402", folder: "Trash" }],
      account_id: "mock_acc",
    });
    expect(r.success).toBe(true);
    expect(r.emails).toHaveLength(1);
    expect(r.emails[0].id).toBe("402");
    expect(r.emails[0].folder).toBe("Trash");
  });

  it("plain showEmails defaults to INBOX and cannot see a Trash-only uid", async () => {
    pushToTrash(403);
    const r = await email.showEmails({ email_ids: ["403"], account_id: "mock_acc" });
    expect(r.success).toBe(false);
    expect(r.failed_ids.map((f) => f.id)).toContain("403");
  });

  it("lookupFolderForUid resolves a uid's folder from the local cache", async () => {
    const dbPath = path.join(process.env.MAILBOX_DATA_DIR, "email_sync.db");
    await syncDb.upsertAccount({ dbPath, id: "mock_acc", email: "mock@example.com", provider: "mock" });
    const { folderId } = await syncDb.upsertFolder({
      dbPath,
      accountId: "mock_acc",
      name: "Archive",
      displayName: "Archive",
      messageCount: 1,
      unreadCount: 0,
      lastSyncIso: new Date().toISOString(),
    });
    await syncDb.upsertEmails({
      dbPath,
      accountId: "mock_acc",
      folderId,
      emails: [{ uid: "777", subject: "archived", from: "a@b.com", date: "2026-01-01 00:00:00" }],
    });
    const folder = await syncDb.lookupFolderForUid({ dbPath, accountId: "mock_acc", uid: "777" });
    expect(folder).toBe("Archive");
  });

  it("showEmailsResolved falls back to cache folder when ref has no folder", async () => {
    const dbPath = path.join(process.env.MAILBOX_DATA_DIR, "email_sync.db");
    pushToTrash(404);
    await syncDb.upsertAccount({ dbPath, id: "mock_acc", email: "mock@example.com", provider: "mock" });
    const { folderId } = await syncDb.upsertFolder({
      dbPath,
      accountId: "mock_acc",
      name: "Trash",
      displayName: "Trash",
      messageCount: 1,
      unreadCount: 0,
      lastSyncIso: new Date().toISOString(),
    });
    await syncDb.upsertEmails({
      dbPath,
      accountId: "mock_acc",
      folderId,
      emails: [{ uid: "404", subject: "deep in trash", from: "old@example.com", date: "2026-01-15 00:00:00" }],
    });
    const r = await email.showEmailsResolved({ refs: [{ id: "404", folder: "" }], account_id: "mock_acc" });
    expect(r.success).toBe(true);
    expect(r.emails[0].folder).toBe("Trash");
  });
});

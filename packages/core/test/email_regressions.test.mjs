import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const email = require("../src/services/email.js");
const syncDb = require("../src/storage/sync_db.js");
const { getMailbox, resetMockState } = require("../src/testing/mock_store.js");

function tmpRoot(name) {
  return path.join(import.meta.dirname, ".tmp", name);
}

function writeAuthJson(configDir) {
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "auth.json"),
    JSON.stringify({
      version: 1,
      accounts: {
        mock_acc: {
          email: "mock@example.com",
          password: "mock",
          provider: "mock",
          description: "Mock account",
        },
      },
      default_account: "mock_acc",
    }, null, 2) + "\n",
    "utf8"
  );
}

function setTestEnv(root) {
  process.env.MAILBOX_INTERNAL_TEST_MODE = "1";
  process.env.MAILBOX_CONFIG_DIR = path.join(root, "config");
  process.env.MAILBOX_DATA_DIR = path.join(root, "data");
  writeAuthJson(process.env.MAILBOX_CONFIG_DIR);
}

describe("email service regressions", () => {
  it("invalidates cached folder unread_count after marking email read", async () => {
    const root = tmpRoot("mark_invalidates_unread_count");
    fs.rmSync(root, { recursive: true, force: true });
    setTestEnv(root);
    resetMockState();

    const dbPath = path.join(process.env.MAILBOX_DATA_DIR, "email_sync.db");
    await syncDb.upsertAccount({ dbPath, id: "mock_acc", email: "mock@example.com", provider: "mock" });
    await syncDb.upsertFolder({
      dbPath,
      accountId: "mock_acc",
      name: "INBOX",
      displayName: "INBOX",
      messageCount: 2,
      unreadCount: 7,
      lastSyncIso: new Date().toISOString(),
    });

    const before = await syncDb.listEmailsFromCache({
      dbPath,
      accountId: "mock_acc",
      folder: "INBOX",
      unreadOnly: true,
      limit: 10,
      offset: 0,
    });
    expect(before.unread_count).toBe(7);

    const marked = await email.markEmails({
      email_ids: ["102"],
      mark_as: "read",
      folder: "INBOX",
      account_id: "mock_acc",
    });
    expect(marked).toHaveProperty("success", true);

    const after = await syncDb.listEmailsFromCache({
      dbPath,
      accountId: "mock_acc",
      folder: "INBOX",
      unreadOnly: true,
      limit: 10,
      offset: 0,
    });
    expect(after.unread_count).toBe(0);
  });

  it("treats an email already in trash as delete success", async () => {
    const root = tmpRoot("delete_already_in_trash");
    fs.rmSync(root, { recursive: true, force: true });
    setTestEnv(root);
    resetMockState();

    const inbox = getMailbox("mock_acc", "INBOX");
    const trash = getMailbox("mock_acc", "Trash");
    const msg = inbox.messages.find((m) => m.uid === 102);
    inbox.messages = inbox.messages.filter((m) => m.uid !== 102);
    trash.messages.push(msg);

    const result = await email.deleteEmails({
      email_ids: ["102"],
      folder: "INBOX",
      account_id: "mock_acc",
      trash_folder: "Trash",
    });

    expect(result).toHaveProperty("success", true);
    expect(result).toHaveProperty("deleted_count", 1);
    expect(result.results[0]).toMatchObject({
      success: true,
      email_id: "102",
      folder: "Trash",
      already_deleted: true,
    });
  });

  it("reports not found when an email is missing from source and trash", async () => {
    const root = tmpRoot("delete_missing_everywhere");
    fs.rmSync(root, { recursive: true, force: true });
    setTestEnv(root);
    resetMockState();

    const result = await email.deleteEmails({
      email_ids: ["999"],
      folder: "INBOX",
      account_id: "mock_acc",
      trash_folder: "Trash",
    });

    expect(result).toHaveProperty("success", false);
    expect(result).toHaveProperty("deleted_count", 0);
    expect(result.results[0]).toMatchObject({
      success: false,
      email_id: "999",
      error: "Email not found in source folder or trash",
    });
  });
});

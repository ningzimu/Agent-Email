import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const email = require("../src/services/email.js");
const { hasAttachmentsFromBodyStructure, attachmentFlags } = require("../src/services/format.js");
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

function pushWithAttachments(uid, attachments) {
  getMailbox("mock_acc", "INBOX").messages.push({
    uid,
    messageId: `<m${uid}@example.com>`,
    subject: `msg ${uid}`,
    from: "bank@example.com",
    to: "mock@example.com",
    cc: "",
    date: "2026-02-03 00:00:00",
    flags: new Set(["\\Seen"]),
    body: "see attachment",
    html: "",
    attachments,
  });
}

describe("WP-F: attachment signature/inline flags", () => {
  beforeEach(() => {
    const root = path.join(import.meta.dirname, ".tmp", "wp_f");
    fs.rmSync(root, { recursive: true, force: true });
    setTestEnv(root);
    resetMockState();
  });

  it("attachmentFlags classifies an S/MIME signature", () => {
    expect(attachmentFlags({ filename: "smime.p7s", contentType: "application/pkcs7-signature" })).toMatchObject({
      is_signature: true,
      is_real_attachment: false,
    });
    expect(attachmentFlags({ filename: "statement.pdf", contentType: "application/pdf" })).toMatchObject({
      is_signature: false,
      is_inline: false,
      is_real_attachment: true,
    });
    expect(attachmentFlags({ filename: "logo.png", contentType: "image/png", related: true })).toMatchObject({
      is_inline: true,
      is_real_attachment: false,
    });
  });

  it("show marks smime.p7s as signature-only and excludes it from real_attachment_count", async () => {
    pushWithAttachments(301, [
      { filename: "smime.p7s", contentType: "application/pkcs7-signature", content: Buffer.from("sig") },
    ]);
    const r = await email.showEmail({ email_id: "301", account_id: "mock_acc" });
    expect(r.attachment_count).toBe(1);
    expect(r.real_attachment_count).toBe(0);
    expect(r.attachments[0]).toMatchObject({ is_signature: true, is_real_attachment: false });
  });

  it("show counts a real attachment alongside a signature", async () => {
    pushWithAttachments(302, [
      { filename: "invoice.pdf", contentType: "application/pdf", content: Buffer.from("pdf") },
      { filename: "smime.p7s", contentType: "application/pkcs7-signature", content: Buffer.from("sig") },
    ]);
    const r = await email.showEmail({ email_id: "302", account_id: "mock_acc" });
    expect(r.attachment_count).toBe(2);
    expect(r.real_attachment_count).toBe(1);
  });

  it("list has_attachments is false for a signature-only message", async () => {
    pushWithAttachments(303, [
      { filename: "smime.p7s", contentType: "application/pkcs7-signature", content: Buffer.from("sig") },
    ]);
    const r = await email.listEmails({ account_id: "mock_acc", folder: "INBOX", limit: 50, use_cache: false });
    const row = r.emails.find((e) => String(e.uid) === "303" || String(e.id) === "303");
    expect(row).toBeTruthy();
    expect(row.has_attachments).toBe(false);
  });

  it("bodyStructure scan ignores signature parts but keeps real ones", () => {
    const sigOnly = { childNodes: [{ disposition: "attachment", parameters: { filename: "smime.p7s" }, type: "application", subtype: "pkcs7-signature" }] };
    const withReal = { childNodes: [{ disposition: "attachment", parameters: { filename: "doc.pdf" }, type: "application", subtype: "pdf" }] };
    expect(hasAttachmentsFromBodyStructure(sigOnly)).toBe(false);
    expect(hasAttachmentsFromBodyStructure(withReal)).toBe(true);
  });
});

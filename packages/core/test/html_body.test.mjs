import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const email = require("../src/services/email.js");
const { getMailbox, resetMockState } = require("../src/testing/mock_store.js");

function tmpRoot(name) {
  return path.join(import.meta.dirname, ".tmp", name);
}

function setTestEnv(root) {
  process.env.MAILBOX_INTERNAL_TEST_MODE = "1";
  process.env.MAILBOX_CONFIG_DIR = path.join(root, "config");
  process.env.MAILBOX_DATA_DIR = path.join(root, "data");
  fs.mkdirSync(process.env.MAILBOX_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.MAILBOX_CONFIG_DIR, "auth.json"),
    JSON.stringify({
      version: 1,
      accounts: {
        mock_acc: { email: "mock@example.com", password: "mock", provider: "mock", description: "Mock" },
      },
      default_account: "mock_acc",
    }) + "\n",
    "utf8"
  );
}

// An HTML-only message (empty text body) like Moomoo/transactional mailers.
function pushHtmlOnly() {
  const inbox = getMailbox("mock_acc", "INBOX");
  inbox.messages.push({
    uid: 201,
    messageId: "<m201@example.com>",
    subject: "HTML only",
    from: "noreply@moomoo.com",
    to: "mock@example.com",
    cc: "",
    date: "2026-02-02 00:00:00",
    flags: new Set([]),
    body: "",
    html: "<div>Hello&nbsp;<b>World</b></div>",
    attachments: [],
  });
}

describe("WP-A: html/body handling", () => {
  beforeEach(() => {
    const root = tmpRoot("wp_a");
    fs.rmSync(root, { recursive: true, force: true });
    setTestEnv(root);
    resetMockState();
  });

  it("html_max_len=0 strips html_body entirely", async () => {
    const r = await email.showEmail({ email_id: "101", account_id: "mock_acc", include_html: true, html_max_len: 0 });
    expect(r.success).toBe(true);
    expect(r.html_body).toBe("");
    expect(r.has_html).toBe(true); // the email DOES have html; we just suppressed it
  });

  it("html_max_len=-1 returns full untruncated html", async () => {
    const r = await email.showEmail({ email_id: "101", account_id: "mock_acc", include_html: true, html_max_len: -1 });
    expect(r.html_body).toBe("<p>hello world</p>");
    expect(r.html_truncated).toBe(false);
  });

  it("html_max_len>0 truncates html", async () => {
    const r = await email.showEmail({ email_id: "101", account_id: "mock_acc", include_html: true, html_max_len: 5 });
    expect(r.html_body.length).toBe(5);
    expect(r.html_truncated).toBe(true);
  });

  it("include_html=false strips html regardless of html_max_len=-1", async () => {
    const r = await email.showEmail({ email_id: "101", account_id: "mock_acc", include_html: false, html_max_len: -1 });
    expect(r.html_body).toBe("");
  });

  it("derives body from html when text body is empty (body_source=html_derived)", async () => {
    pushHtmlOnly();
    const r = await email.showEmail({ email_id: "201", account_id: "mock_acc", include_html: false });
    expect(r.success).toBe(true);
    expect(r.body).toBe("Hello World");
    expect(r.body_source).toBe("html_derived");
  });

  it("body_source=text for a normal text email", async () => {
    const r = await email.showEmail({ email_id: "102", account_id: "mock_acc" });
    expect(r.body).toContain("unread body");
    expect(r.body_source).toBe("text");
  });

  it("showEmails batch applies the same html semantics and html->text fallback", async () => {
    pushHtmlOnly();
    const r = await email.showEmails({
      email_ids: ["101", "201"],
      account_id: "mock_acc",
      include_html: true,
      html_max_len: 0,
    });
    expect(r.success).toBe(true);
    const byId = Object.fromEntries(r.emails.map((e) => [e.id, e]));
    expect(byId["101"].html_body).toBe(""); // stripped by html_max_len=0
    expect(byId["201"].body).toBe("Hello World");
    expect(byId["201"].body_source).toBe("html_derived");
  });
});

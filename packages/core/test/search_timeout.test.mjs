import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const email = require("../src/services/email.js");
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

describe("WP review-fix: search deadline", () => {
  beforeEach(() => {
    const root = path.join(import.meta.dirname, ".tmp", "search_timeout");
    fs.rmSync(root, { recursive: true, force: true });
    setTestEnv(root);
    resetMockState();
  });

  it("_deadlineExceeded is a correct pure predicate (0 = no limit)", () => {
    expect(email._deadlineExceeded(1000, 0, 999999)).toBe(false); // 0 => unbounded
    expect(email._deadlineExceeded(1000, 50, 1040)).toBe(false); // 40ms < 50ms
    expect(email._deadlineExceeded(1000, 50, 1050)).toBe(true); // 50ms >= 50ms
    expect(email._deadlineExceeded(1000, 50, 5000)).toBe(true);
  });

  it("normal search with a generous timeout is unaffected (timed_out false)", async () => {
    const r = await email.searchEmails({ query: "hello", account_id: "mock_acc", folder: "all", limit: 10, timeout_ms: 60000 });
    expect(r.success).toBe(true);
    expect(r.timed_out).toBe(false);
    expect(r.emails.length).toBeGreaterThan(0);
  });
});

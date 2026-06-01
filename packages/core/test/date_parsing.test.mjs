import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const email = require("../src/services/email.js");

describe("WP-H: relative date parsing (MCP dateRel fix)", () => {
  it("expands <N><unit> shortcuts to a concrete date (the MCP path used to drop these)", () => {
    // Before the fix: new Date("2d") => NaN => filter silently ignored.
    const r = email._parseDateInput("2d");
    expect(r.date).toBeInstanceOf(Date);
    expect(Number.isNaN(r.date.getTime())).toBe(false);
    expect(r.warning).toBeUndefined();
  });

  it("expands named shortcuts (today/yesterday/last-week)", () => {
    for (const s of ["today", "yesterday", "last-week", "1w", "3mo"]) {
      const r = email._parseDateInput(s);
      expect(r.date, `shortcut ${s}`).toBeInstanceOf(Date);
    }
  });

  it("_expandRelativeDate('7d') yields a YYYY-MM-DD string", () => {
    expect(email._expandRelativeDate("7d")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("returns an explicit warning (not a silent drop) for an unparseable date", () => {
    const r = email._parseDateInput("not-a-date");
    expect(r.date).toBeNull();
    expect(r.warning).toMatch(/unparseable/i);
  });

  it("still parses absolute YYYY-MM-DD dates", () => {
    const r = email._parseDateInput("2026-02-01");
    expect(r.sql).toBe("2026-02-01 00:00:00");
    expect(r.date).toBeInstanceOf(Date);
  });
});

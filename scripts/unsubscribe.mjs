#!/usr/bin/env node
// Bulk unsubscribe helper.
//
// Reads the List-Unsubscribe header from one email per (account_id, sender)
// pair and acts on it:
//   - mailto:  → sends an unsubscribe email via your SMTP credentials
//   - https:// → opens the link in your default browser
//
// Input: lines of "account_id<TAB>from_substring" on stdin, or a path to a
// file with the same format. Lines starting with `#` are skipped.
//
//   echo "env_163\thello@mermaid.ai" | node scripts/unsubscribe.mjs
//   node scripts/unsubscribe.mjs targets.tsv
//
// Run with --dry-run to only print what would happen.

import { createRequire } from "module";
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const coreDir = path.join(__dirname, "../packages/core");
const email = require(path.join(coreDir, "src/services/email.js"));

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const inputPath = args.find((a) => !a.startsWith("--"));

function readTargets() {
  let raw = "";
  if (inputPath) {
    raw = fs.readFileSync(inputPath, "utf8");
  } else if (!process.stdin.isTTY) {
    raw = fs.readFileSync(0, "utf8");
  } else {
    console.error("Usage: unsubscribe.mjs [--dry-run] [targets.tsv]");
    console.error("Or pipe lines of 'account_id<TAB>from_substring' on stdin.");
    process.exit(2);
  }
  return raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => {
      const [accountId, ...rest] = l.split(/\s+/);
      return { accountId, fromAddr: rest.join(" ") };
    })
    .filter((t) => t.accountId && t.fromAddr);
}

async function getOneUid(accountId, fromAddr) {
  const result = await email.searchEmails({
    from: fromAddr,
    account_id: accountId,
    limit: 1,
    folder: "INBOX",
  });
  return result?.emails?.[0]?.uid || null;
}

async function main() {
  const targets = readTargets();
  if (targets.length === 0) {
    console.error("No targets provided.");
    process.exit(2);
  }

  const mailtoList = [];
  const httpList = [];
  const noHeader = [];

  for (const { accountId, fromAddr } of targets) {
    process.stdout.write(`  ${fromAddr} (${accountId})... `);
    try {
      const uid = await getOneUid(accountId, fromAddr);
      if (!uid) { console.log("no email found"); continue; }
      const shown = await email.showEmail({ email_id: uid, account_id: accountId });
      const lu = shown?.list_unsubscribe;
      if (!lu) { console.log("no List-Unsubscribe"); noHeader.push({ accountId, fromAddr }); continue; }
      if (lu.mailto) { console.log("mailto"); mailtoList.push({ accountId, fromAddr, mailto: lu.mailto }); }
      else if (lu.http) { console.log("http"); httpList.push({ accountId, fromAddr, url: lu.http }); }
    } catch (e) {
      console.log(`error: ${e.message}`);
    }
  }

  if (dryRun) {
    console.log("\n--dry-run: not sending or opening anything");
    console.log(`mailto unsubscribes: ${mailtoList.length}`);
    console.log(`http unsubscribes:   ${httpList.length}`);
    console.log(`no header:           ${noHeader.length}`);
    return;
  }

  for (const { accountId, mailto } of mailtoList) {
    const url = new URL(mailto);
    const to = url.pathname;
    const subject = url.searchParams.get("subject") || "unsubscribe";
    const body = url.searchParams.get("body") || "unsubscribe";
    process.stdout.write(`  send → ${to}... `);
    try {
      const r = await email.sendEmail({ to, subject, body, account_id: accountId });
      console.log(r.success ? "sent" : `failed: ${r.error}`);
    } catch (e) { console.log(`error: ${e.message}`); }
  }

  for (const { fromAddr, url } of httpList) {
    console.log(`  open → ${fromAddr}`);
    try { execSync(`open "${url}"`, { stdio: "ignore" }); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 500));
  }
}

main().catch((e) => { console.error("Fatal:", e.message); process.exit(1); });

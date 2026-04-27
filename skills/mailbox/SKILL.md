---
name: mailbox
description: Read, search, send, and manage email across Gmail, QQ, 163, Outlook and any IMAP/SMTP account from the command line. Use when the user asks to "read my email", "查邮件", "look up an Amazon order email", "find the customer review notification", "send an email", "回复邮件", "delete spam", "查未读", "show unread", "synchronize my mailbox", "set up MCP for email", or anything that involves listing / searching / reading / writing / classifying messages from one or more mailboxes.
metadata:
  author: leeguooooo
  version: "0.1.0"
  homepage: https://github.com/leeguooooo/Mailbox
keywords:
  - mailbox
  - email
  - imap
  - smtp
  - gmail
  - qq
  - 163
  - outlook
  - 邮件
  - 邮箱
---

# Mailbox CLI Skill

Drives the `@leeguoo/mailbox-cli` Node CLI to read and manage email across
multiple IMAP accounts. Returns a stable JSON contract — every response
includes `success: boolean` and, on failure, `error: string` +
`error_code: string` (machine-readable).

## Setup (one time, by the user)

```bash
# 1. Install the CLI globally from npm:
npm install -g @leeguoo/mailbox-cli

# 2. Configure accounts (edit credentials):
mkdir -p ~/.config/mailbox
cp $(npm prefix -g)/lib/node_modules/@leeguoo/mailbox-cli/examples/accounts.example.json \
   ~/.config/mailbox/auth.json
$EDITOR ~/.config/mailbox/auth.json

# 3. (Recommended) install the persistent daemon for ~5-30× faster calls:
mailbox daemon install
mailbox daemon status --json   # confirm it's running

# 4. (Optional) wire into Claude Desktop / Code via MCP:
mailbox mcp config --json   # prints a paste-ready mcpServers entry
```

If the user hasn't done step 1, every CLI call will fail with `command not found`.
Always probe with `mailbox --version` first when in doubt.

## How to drive this CLI from an agent loop

Always pass `--json` so the response is machine-parseable. Check `success`
before continuing.

### Read / search

```bash
# List recent emails (cache when warm; pass --live to force IMAP):
mailbox email list --account-id <id> --limit 20 --json
mailbox email list --account-id <id> --limit 20 --with-preview 200 --json   # +body snippet, one trip

# Search (server-side IMAP for Gmail; client-side fallback for QQ/163/Outlook):
mailbox email search --from amazon --subject review --folder all --json
mailbox email search --query "interview"  --date-from 2w --json    # relative dates: 2d/3w/1mo/today/yesterday

# NOTE: on QQ/163/126/sina/aliyun/outlook, IMAP TEXT search is broken,
# so the CLI falls back to envelope-only client-side filtering. That
# means `--query` only matches against `subject + from` for those
# providers — pure body-text matches will be missed. Use `--from` /
# `--subject` for predictable results, or use a Gmail account where
# X-GM-RAW does search the body server-side.

# Read one or many emails (AI-friendly defaults: text only, capped at 2000 chars, URLs stripped):
mailbox email show <gid> --json                    # gid = "<account_id>:<uid>" — no --account-id needed
mailbox email show <gid1> <gid2> <gid3> --json     # batch — one IMAP connection
mailbox email show <gid> --full --json             # raw HTML + uncapped + URLs (rarely needed)

# Folders:
mailbox email folders --account-id <id> --json
```

### Mutate (all dry-run by default)

```bash
mailbox email mark <gid> --read --confirm --json
mailbox email delete <gid> --confirm --json        # default moves to Trash; pass --permanent to expunge
mailbox email flag <gid> --set --confirm --json
mailbox email move <gid1> <gid2> --target-folder Archive --confirm --json
mailbox email send --to a@b.com --subject hi --body "..." --confirm --json
```

Without `--confirm`, every destructive command returns a JSON dry-run
preview (recipients / would-mark count / etc.) and changes nothing.

### Discover the surface

```bash
mailbox account list --json
mailbox <cmd> --help --json   # structured help: { name, description, options, arguments, subcommands }
```

## Token-saving tips

- **`--lean` (global flag, before subcommand)** strips ~10 noisy/duplicate top-level fields and per-email duplicates. Typical response shrinks by ~30%.
- **`--with-preview <N>`** on `email list / email search` fetches a body snippet alongside the envelope — saves one `email show` per email.
- **Batch `email show <gid1> <gid2> ...`** reuses one IMAP connection. Use it whenever you need ≥2 emails.
- **`gid`** (returned in every list/search/show response) is the global ID — pass it instead of bare UID + `--account-id`.
- **Relative date shortcuts**: `--date-from 2d` (2 days ago), `3w`, `1mo`, `1y`, `12h`, `30m`, `today`, `yesterday`, `last-week`, `last-month`. ISO 8601 / `YYYY-MM-DD` still work.
- **`mailbox <cmd> --help --json`** returns a JSON descriptor of arguments, options, defaults — use to introspect any command instead of parsing human text.

## Output contract

- Every response: `success: boolean`. On failure: `error: string` + `error_code: string`.
- Common `error_code` values: `account_not_found`, `email_not_found`, `folder_not_found`, `invalid_argument`, `invalid_date`, `invalid_limit`, `ambiguous_account`, `size_limit`, `auth_failed`, `network_error`, `imap_error`, `smtp_error`, `operation_failed`, `unknown_error`.
- Exit codes: 0 success, 1 operation failed, 2 invalid usage.
- Every email object carries `gid` ("`<account_id>:<uid>`"). Prefer it over bare `id`/`uid`.
- Batch `email show` returns `{ success, emails: [...], failed_ids: [{id, error}], requested, returned }`.
- `--with-preview` adds `preview: string` and `preview_truncated: bool` per email.

## Safety rules

- Always pass `--json`. Always check `success`.
- Pass either a `gid` OR `--account-id <id>` for any per-email command.
- Mutating commands (`email send / delete / mark / move / flag`, `digest run`) default to **dry-run**; the agent must explicitly add `--confirm` after the user approves.
- Never leak account credentials in logs or model output.

## MCP server mode

Instead of shelling out to the CLI, an AI client can call mailbox tools
directly over MCP:

```bash
mailbox mcp config --json   # prints an mcpServers entry to paste into the client config
mailbox mcp serve           # run the server manually for testing (stdio)
```

15 tools registered: `account_list`, `account_test_connection`,
`email_list`, `email_search`, `email_show`, `email_folders`,
`email_mark`, `email_delete`, `email_flag`, `email_move`, `email_send`,
`sync_status`, `sync_force`, `inbox_organize`, `digest_run`.

Each destructive tool defaults to dry-run; pass `confirm: true` to apply.

## Persistent daemon (5-30× faster CLI calls)

Each one-shot CLI invocation otherwise spends 1-3s on TCP+TLS+IMAP LOGIN.
With the daemon running, every CLI call reuses pooled connections, and
the daemon also runs a background SQLite sync so `email list` (without
`--live`) usually doesn't touch IMAP at all.

```bash
mailbox daemon install      # autostart at login (macOS launchd / Linux systemd-user)
mailbox daemon status --json
mailbox daemon reload       # drop pooled connections after editing auth.json
mailbox daemon stop
```

Set `MAILBOX_NO_DAEMON=1` to skip the daemon probe entirely.

Measured (Gmail INBOX, M2 MacBook over residential WAN):

| Operation | No daemon | Daemon (--live) | Daemon (cached) |
|---|---|---|---|
| Single `email list` | 5.0s | 1.0s | 0.17s |
| `email folders` | 5.0s | 0.85s | n/a |
| 5 sequential `email list` | 25s | 5.3s | **0.83s** |
| 3 parallel `email show` | ~15s | 2.7s | **0.88s** |

## Reference

- Repo: https://github.com/leeguooooo/Mailbox
- npm: https://www.npmjs.com/package/@leeguoo/mailbox-cli
- JSON contract docs: `docs/CLI_JSON_CONTRACT.md`

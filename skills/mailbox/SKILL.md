# Mailbox CLI (OpenClaw Skill)

Use the mailbox CLI as a tool to read and manage email. OpenClaw handles
channel delivery and scheduling. The mailbox CLI returns structured JSON
outputs and optional text summaries.

## Requirements
- mailbox CLI installed (`npm install -g mailbox-cli`)
- Credentials in `~/.config/mailbox/auth.json`

## Commands (examples)
- `mailbox account list --json`
- `mailbox email list --limit 20 --json`
- `mailbox email list --limit 20 --with-preview 200 --json` — envelope + first 200 chars of body in one call
- `mailbox email search --from amazon --subject review --folder all --json`
- `mailbox email show <email_uid> --account-id <account_id> --json` — AI-friendly defaults: text only, body capped at 2000 chars, URLs stripped
- `mailbox email show <uid1> <uid2> <uid3> --account-id <account_id> --json` — batch read multiple emails over one IMAP connection
- `mailbox email show <email_uid> --account-id <account_id> --full --json` — opt back to raw HTML + uncapped body + URLs
- `mailbox email delete <email_uid> --account-id <account_id> --folder INBOX --confirm --json`
- `mailbox email send --to a@b.com --subject hi --body x --confirm --json` — destructive; without --confirm returns dry-run preview
- `mailbox digest run --confirm --json` — without --confirm returns dry-run preview
- `mailbox monitor run --json`
- `mailbox inbox --limit 15 --text`

## Persistent daemon (4-6× faster IMAP calls)

Each one-shot CLI invocation otherwise spends 1-3s on TCP+TLS+IMAP LOGIN.
Run a daemon once and every subsequent CLI call reuses pooled connections:

```bash
# Start (foreground; use nohup / launchd / systemd to detach):
mailbox daemon start

# Inspect:
mailbox daemon status --json    # pid, uptime, per-account pool state
mailbox daemon reload           # drop pooled connections (after editing auth.json)
mailbox daemon stop
```

Once running, every other `mailbox …` call automatically routes through
the daemon's Unix socket. If the socket is missing or unreachable, the
CLI falls back to direct IMAP (current behavior) — no config change
needed. Set `MAILBOX_NO_DAEMON=1` to skip the probe entirely.

Socket path: `${XDG_RUNTIME_DIR}/mailbox-{uid}.sock` or
`~/.cache/mailbox/daemon-{uid}.sock`. Override with
`MAILBOX_DAEMON_SOCKET=/path`.

Typical speedup measured against Gmail INBOX:
- `email folders`: 5.0s → 0.85s (5.9×)
- `email list --live`: 5.0s → 1.0s (5×)
- `5 × folder list back-to-back`: 17.6s → 4.0s (4.4×)

## Token-saving tips for AI agents
- Add `--lean` (global, before subcommand) to strip noisy/duplicate fields: `mailbox --lean email search ...` — typically ~30% smaller responses.
- Use `--with-preview <N>` on `email list` / `email search` to avoid one round-trip per email when you only need a snippet.
- Pass multiple UIDs to `email show` instead of looping — one IMAP connection per batch.
- `email show` defaults are now AI-friendly (no HTML, body capped at 2000 chars, URLs stripped). Pass `--full` only when you actually need raw content.
- Use the global ID (`gid = "<account_id>:<uid>"`) returned in every list/search/show response — pass it to `email show / mark / delete / move / flag / attachments` instead of `--account-id <id> <uid>` separately. Mixed-account gids in one call are rejected.
- Date filters accept relative shortcuts: `--date-from 2d` (2 days ago), `3w`, `1mo`, `1y`, `12h`, `30m`, `today`, `yesterday`, `last-week`, `last-month`. ISO 8601 / `YYYY-MM-DD` still work.
- Run `mailbox <cmd> [<sub>] --help --json` to get a structured descriptor of arguments, options, defaults, required flags, and subcommands.

## Safety rules
- Always use `--json` for automation and check `success`.
- Pass either a `gid` or include `--account-id` for destructive operations.
- Destructive operations default to dry-run unless `--confirm` is provided.
  This includes: `email send`, `email delete`, `email mark`, `email move`, `email flag`, and `digest run`.
- Prefer `--dry-run` before mutating when available.

## Output contract
- JSON response includes `success: boolean` (always present), `error: string` and `error_code: string` (on failure).
- Common `error_code` values: `account_not_found`, `email_not_found`, `folder_not_found`, `invalid_argument`, `invalid_date`, `invalid_limit`, `ambiguous_account`, `size_limit`, `auth_failed`, `network_error`, `imap_error`, `smtp_error`, `operation_failed`, `unknown_error`.
- Exit codes: 0 success, 1 operation failed, 2 invalid usage.
- `--lean` removes the following noisy top-level fields: `accounts_info`, `accounts_count`, `accounts_searched`, `search_time`, `search_params`, `failed_searches`, `partial_success`, `from_cache`, `use_cache`, `unread_only`, `folder`, `account_id`, `date_from/to`, `limit`, `offset`, `total_emails`, `total_unread`, `displayed`, plus per-email duplicates (`uid`, `to`, `flagged`, `account`, `source`, `is_flagged`, empty `preview`).
- Per-email preview from `--with-preview` appears as `preview` (string) and `preview_truncated` (bool).
- Every email object carries `gid` (global ID) — prefer it over the bare `id`/`uid` for cross-call references.
- Batch `email show` returns `{ success, emails: [...], failed_ids: [{id, error}], requested, returned }` instead of a single email object.
- `mailbox <cmd> --help --json` returns `{ success: true, help: { name, description, usage, arguments, options, subcommands } }`.

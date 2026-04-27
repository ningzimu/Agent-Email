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

## Token-saving tips for AI agents
- Add `--lean` (global, before subcommand) to strip noisy/duplicate fields: `mailbox --lean email search ...` — typically ~30% smaller responses.
- Use `--with-preview <N>` on `email list` / `email search` to avoid one round-trip per email when you only need a snippet.
- Pass multiple UIDs to `email show` instead of looping — one IMAP connection per batch.
- `email show` defaults are now AI-friendly (no HTML, body capped at 2000 chars, URLs stripped). Pass `--full` only when you actually need raw content.

## Safety rules
- Always use `--json` for automation and check `success`.
- Include `--account-id` for destructive operations.
- Destructive operations default to dry-run unless `--confirm` is provided.
  This includes: `email send`, `email delete`, `email mark`, `email move`, `email flag`, and `digest run`.
- Prefer `--dry-run` before mutating when available.

## Output contract
- JSON response includes `success: boolean` (always present) and `error: string` (on failure).
- Exit codes: 0 success, 1 operation failed, 2 invalid usage.
- `--lean` removes the following noisy top-level fields: `accounts_info`, `accounts_count`, `accounts_searched`, `search_time`, `search_params`, `failed_searches`, `partial_success`, `from_cache`, `use_cache`, `unread_only`, `folder`, `account_id`, `date_from/to`, `limit`, `offset`, `total_emails`, `total_unread`, `displayed`, plus per-email duplicates (`uid`, `to`, `flagged`, `account`, `source`, `is_flagged`, empty `preview`).
- Per-email preview from `--with-preview` appears as `preview` (string) and `preview_truncated` (bool).
- Batch `email show` returns `{ success, emails: [...], failed_ids: [{id, error}], requested, returned }` instead of a single email object.

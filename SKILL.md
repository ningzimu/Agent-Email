---
name: mailbox
description: Read, search, send, and manage email across Gmail, QQ, 163, Outlook and any IMAP/SMTP account from the command line. See skills/mailbox/SKILL.md for full instructions.
metadata:
  author: leeguooooo
  version: "0.1.0"
  homepage: https://github.com/leeguooooo/Mailbox
keywords:
  - mailbox
  - email
  - imap
  - smtp
---

# Mailbox CLI

The canonical skill lives at [`skills/mailbox/SKILL.md`](./skills/mailbox/SKILL.md).
This top-level file exists so OpenClaw discovers the skill at the repo
root; the body of the actual skill is in the `skills/mailbox/` directory.

## Install

Via [skills](https://skills.sh):

```bash
npx skills add leeguooooo/Mailbox --skill mailbox       # project-scope (./<agent>/skills/)
npx skills add leeguooooo/Mailbox --skill mailbox -g    # user-scope (~/<agent>/skills/)
```

Or directly from npm:

```bash
npm install -g @leeguoo/mailbox-cli
mailbox --help
```

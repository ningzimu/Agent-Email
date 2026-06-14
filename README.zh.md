# Mailbox CLI

以 CLI 为核心的多邮箱（IMAP/SMTP）管理工具，支持本地同步缓存（SQLite）。

主入口：`mailbox` CLI（Node.js 实现）。本仓库通过 GitHub Releases 分发按平台预编译二进制，终端用户无需安装 Python。

说明：本仓库不再提供 MCP server/stdio 能力。

## 安装

### GitHub Releases（推荐）

使用安装脚本下载当前平台的预编译二进制：

```bash
curl -fsSL https://raw.githubusercontent.com/ningzimu/Agent-Email/main/install.sh | sh
mailbox --help
```

默认安装到 `~/.local/bin`。可以通过环境变量指定版本或安装目录：

```bash
curl -fsSL https://raw.githubusercontent.com/ningzimu/Agent-Email/main/install.sh | MAILBOX_VERSION=v2.14.0 sh
curl -fsSL https://raw.githubusercontent.com/ningzimu/Agent-Email/main/install.sh | MAILBOX_INSTALL_DIR=/usr/local/bin sh
```

发布渠道只使用 GitHub Releases，不再发布 npm 包。

### 从源码开发

```bash
pnpm install
pnpm test
pnpm build:binary
```

## 配置邮箱

```bash
mkdir -p ~/.config/mailbox
cp examples/accounts.example.json ~/.config/mailbox/auth.json
```

配置文件位置：

- 认证信息：`~/.config/mailbox/auth.json`
- 其他配置：`~/.config/mailbox/config.toml`

## 常用命令

```bash
# 交互式
mailbox

# 列出账户
mailbox account list --json

# 列出未读邮件（默认优先缓存；--from 缓存侧按发件人过滤）
mailbox email list --unread-only --limit 20 --json
mailbox email list --account-id my_account_id --from "newsletter" --json

# 查看邮件详情（响应包含 list_unsubscribe，方便一键退订）
mailbox email show 123456 --account-id my_account_id --json

# 标记已读（建议先 dry-run）
mailbox email mark 123456 --read --account-id my_account_id --folder INBOX --dry-run --json
mailbox email mark 123456 --read --account-id my_account_id --folder INBOX --confirm --json

# 按发件人/主题批量操作（无需先查 UID）
mailbox email mark --from "support@example.com" --read --confirm --account-id my_account_id --json
mailbox email delete --from "newsletter" --account-id my_account_id --json   # 不带 --confirm 是 dry-run 预览
mailbox email delete --subject "[ad]" --account-id my_account_id --confirm --json

# 连接测试
mailbox account test-connection --json
```

## AI 集成说明

- `docs/AI_SKILL_MAILBOX_CLI.md`

## OpenClaw 集成

本仓库包含 OpenClaw 技能：`skills/mailbox/SKILL.md`。

OpenClaw 默认加载以下目录的技能：
- `<workspace>/skills`
- `~/.openclaw/skills`

快速链接脚本（将仓库 skill 软链到 `~/.openclaw/skills`）：

```bash
./scripts/link_openclaw_skill.sh
```

如需覆盖已有链接：

```bash
./scripts/link_openclaw_skill.sh --force
```

如需直接引用本仓库的技能目录，可在 `~/.openclaw/openclaw.json`
中添加 `skills.load.extraDirs`：

```json
{
  "skills": {
    "load": {
      "extraDirs": [
        "/path/to/mcp-email-service/skills"
      ]
    }
  }
}
```

OpenClaw 负责渠道投递与定时调度；mailbox 只输出结构化 JSON 与可选摘要文本。

验证 OpenClaw 是否加载成功：

```bash
openclaw skills list --eligible
openclaw skills check
```

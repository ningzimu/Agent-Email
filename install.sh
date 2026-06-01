#!/bin/sh
# mailbox CLI installer — downloads a prebuilt binary from GitHub Releases.
# No npm, no Node, no tokens required.
#
#   curl -fsSL https://raw.githubusercontent.com/leeguooooo/Mailbox/main/install.sh | sh
#
# Env overrides:
#   MAILBOX_VERSION=v2.11.2   install a specific tag (default: latest release)
#   MAILBOX_INSTALL_DIR=...   install dir (default: ~/.local/bin)
set -eu

REPO="leeguooooo/Mailbox"
INSTALL_DIR="${MAILBOX_INSTALL_DIR:-$HOME/.local/bin}"
VERSION="${MAILBOX_VERSION:-}"

err() { printf 'mailbox-install: %s\n' "$1" >&2; exit 1; }

# --- detect platform ---------------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin)
    case "$arch" in
      arm64|aarch64) target="darwin-arm64" ;;
      x86_64)        target="darwin-x64" ;;
      *) err "unsupported macOS arch: $arch" ;;
    esac ;;
  Linux)
    case "$arch" in
      x86_64) target="linux-x64-gnu" ;;
      *) err "unsupported Linux arch: $arch (only x86_64 prebuilt)" ;;
    esac ;;
  *) err "unsupported OS: $os (macOS/Linux only; on Windows use WSL or npm)" ;;
esac

# --- resolve download URL ----------------------------------------------------
asset="mailbox-${target}.tar.gz"
if [ -n "$VERSION" ]; then
  base="https://github.com/${REPO}/releases/download/${VERSION}"
else
  base="https://github.com/${REPO}/releases/latest/download"
fi
url="${base}/${asset}"

# --- download + verify + install --------------------------------------------
command -v curl >/dev/null 2>&1 || err "curl is required"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

printf 'mailbox-install: downloading %s\n' "$url"
curl -fSL --retry 3 -o "$tmp/$asset" "$url" || err "download failed (does the release have ${asset}?)"

# Optional checksum verification when the .sha256 sidecar is present.
if curl -fsSL --retry 2 -o "$tmp/$asset.sha256" "${url}.sha256" 2>/dev/null; then
  expected="$(awk '{print $1}' "$tmp/$asset.sha256")"
  if command -v sha256sum >/dev/null 2>&1; then
    actual="$(sha256sum "$tmp/$asset" | awk '{print $1}')"
  elif command -v shasum >/dev/null 2>&1; then
    actual="$(shasum -a 256 "$tmp/$asset" | awk '{print $1}')"
  else
    actual=""
  fi
  if [ -n "$actual" ] && [ "$expected" != "$actual" ]; then
    err "checksum mismatch (expected $expected, got $actual)"
  fi
  [ -n "$actual" ] && printf 'mailbox-install: checksum ok\n'
fi

tar -xzf "$tmp/$asset" -C "$tmp"
[ -f "$tmp/mailbox" ] || err "archive did not contain a 'mailbox' binary"

mkdir -p "$INSTALL_DIR"
mv "$tmp/mailbox" "$INSTALL_DIR/mailbox"
chmod +x "$INSTALL_DIR/mailbox"

printf 'mailbox-install: installed to %s/mailbox\n' "$INSTALL_DIR"
"$INSTALL_DIR/mailbox" --version >/dev/null 2>&1 && \
  printf 'mailbox-install: version %s\n' "$("$INSTALL_DIR/mailbox" --version 2>/dev/null)" || true

# --- PATH hint ---------------------------------------------------------------
case ":$PATH:" in
  *":$INSTALL_DIR:"*) : ;;
  *) printf 'mailbox-install: NOTE — add %s to your PATH:\n  export PATH="%s:$PATH"\n' "$INSTALL_DIR" "$INSTALL_DIR" ;;
esac

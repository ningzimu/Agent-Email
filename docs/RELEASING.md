# Releasing

This fork ships one distribution channel:

1. A standalone `mailbox` binary published as GitHub Release assets.

The project does not publish npm packages.

## Manual Release

Use a semantic version tag:

```bash
git checkout main
git pull --ff-only origin main
git tag vX.Y.Z
git push origin vX.Y.Z
```

Pushing a `v*` tag triggers `.github/workflows/release-binaries.yml`.

The workflow builds and attaches these assets to the GitHub Release:

- `mailbox-darwin-arm64.tar.gz`
- `mailbox-darwin-x64.tar.gz`
- `mailbox-linux-x64-gnu.tar.gz`

Each archive has a matching `.sha256` file.

## Version Stamping

`release-binaries` writes the tag version into `packages/cli/src/_version.js`
before building the binary. Keep `_version.js` at `0.0.0` in git; do not commit
real release versions there.

## Local Verification

Before tagging, run:

```bash
pnpm test
pnpm build:binary
./dist/mailbox --version
```

`pnpm build:binary` writes the local binary to `dist/mailbox`.

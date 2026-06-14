#!/usr/bin/env node

const child_process = require("child_process");
const fs = require("fs");
const path = require("path");

function pkgTarget() {
  const platform = process.platform;
  const arch = process.arch;

  // pkg currently supports up to Node 18 targets.
  if (platform === "darwin" && arch === "arm64") return "node18-macos-arm64";
  if (platform === "darwin" && arch === "x64") return "node18-macos-x64";
  if (platform === "linux" && arch === "x64") return "node18-linux-x64";
  return null;
}

function run(cmd, args) {
  child_process.execFileSync(cmd, args, { stdio: "inherit" });
}

function ensureBinary(pkgBin, entry, target, outBin) {
  run(pkgBin, [entry, "--targets", target, "--output", outBin]);
  if (!fs.existsSync(outBin)) {
    console.warn(`pkg did not produce ${outBin}. Retrying once...`);
    run(pkgBin, [entry, "--targets", target, "--output", outBin]);
  }
  if (!fs.existsSync(outBin)) {
    console.error(`pkg failed to produce ${outBin}`);
    try {
      const dir = path.dirname(outBin);
      if (fs.existsSync(dir)) {
        console.error(`dist contents: ${fs.readdirSync(dir).join(", ") || "(empty)"}`);
      }
    } catch {
      // ignore
    }
    process.exit(1);
  }
}

function main() {
  const target = pkgTarget();
  if (!target) {
    console.error(`Unsupported platform for binary build: ${process.platform} ${process.arch}`);
    process.exit(1);
  }

  const entry = path.join(__dirname, "..", "packages", "cli", "bin", "mailbox.js");
  const outDir = path.join(__dirname, "..", "dist");
  fs.mkdirSync(outDir, { recursive: true });

  const outBin = path.join(outDir, "mailbox");
  console.log(`Building mailbox binary: target=${target}`);
  const root = path.join(__dirname, "..");
  const pkgBin = path.join(root, "node_modules", ".bin", process.platform === "win32" ? "pkg.cmd" : "pkg");
  if (!fs.existsSync(pkgBin)) {
    console.error("Missing pkg dependency. Run `pnpm install` first.");
    process.exit(1);
  }
  ensureBinary(pkgBin, entry, target, outBin);
  fs.chmodSync(outBin, 0o755);
  console.log(`Wrote binary to: ${outBin}`);
}

main();

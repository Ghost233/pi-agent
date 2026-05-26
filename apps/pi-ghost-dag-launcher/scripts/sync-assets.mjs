#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(ROOT, "node_modules/@tabler/icons-webfont/dist");
const target = path.join(ROOT, "src/vendor/tabler-icons");
const xtermSource = path.join(ROOT, "node_modules/@xterm/xterm");
const fitSource = path.join(ROOT, "node_modules/@xterm/addon-fit");
const xtermTarget = path.join(ROOT, "src/vendor/xterm");

if (!fs.existsSync(source)) {
  throw new Error("Missing @tabler/icons-webfont. Run npm install first.");
}
if (!fs.existsSync(xtermSource) || !fs.existsSync(fitSource)) {
  throw new Error("Missing @xterm packages. Run npm install first.");
}

fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(path.join(target, "fonts"), { recursive: true });
fs.copyFileSync(
  path.join(source, "tabler-icons.min.css"),
  path.join(target, "tabler-icons.min.css"),
);
fs.cpSync(path.join(source, "fonts"), path.join(target, "fonts"), {
  recursive: true,
});

fs.rmSync(xtermTarget, { recursive: true, force: true });
fs.mkdirSync(xtermTarget, { recursive: true });
fs.copyFileSync(path.join(xtermSource, "lib/xterm.mjs"), path.join(xtermTarget, "xterm.mjs"));
fs.copyFileSync(path.join(xtermSource, "css/xterm.css"), path.join(xtermTarget, "xterm.css"));
fs.copyFileSync(path.join(fitSource, "lib/addon-fit.mjs"), path.join(xtermTarget, "addon-fit.mjs"));

const cargo = spawnSync("cargo", ["build", "--release", "--bin", "pi-ghost-dag-server"], {
  cwd: path.join(ROOT, "src-tauri"),
  stdio: "inherit",
});

if (cargo.status !== 0) {
  throw new Error("Failed to build pi-ghost-dag-server");
}

#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverBinary = path.join(ROOT, "src-tauri/target/release/pi-ghost-dag-server");
const appResources = path.join(
  ROOT,
  "src-tauri/target/release/bundle/macos/Pi Ghost DAG Launcher.app/Contents/Resources",
);
const targetDir = path.join(appResources, "bin");
const targetBinary = path.join(targetDir, "pi-ghost-dag-server");
const accidentalMacOSBinary = path.join(
  appResources,
  "../MacOS/pi-ghost-dag-server",
);

if (!fs.existsSync(serverBinary)) {
  throw new Error(`Missing server binary: ${serverBinary}`);
}

if (!fs.existsSync(appResources)) {
  throw new Error(`Missing app bundle resources directory: ${appResources}`);
}

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(serverBinary, targetBinary);
fs.chmodSync(targetBinary, 0o755);

if (fs.existsSync(accidentalMacOSBinary)) {
  fs.rmSync(accidentalMacOSBinary);
}

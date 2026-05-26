#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { startServer } from "./server.mjs";

function parseArgs(argv) {
  const args = {
    cwd: process.cwd(),
    host: "127.0.0.1",
    port: 7331,
    open: true,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cwd") {
      args.cwd = argv[++index];
    } else if (arg === "--host") {
      args.host = argv[++index];
    } else if (arg === "--port") {
      args.port = Number(argv[++index]);
    } else if (arg === "--no-open") {
      args.open = false;
    } else if (!arg.startsWith("-") && !args.positionalCwd) {
      args.cwd = arg;
      args.positionalCwd = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  args.cwd = path.resolve(args.cwd);
  return args;
}

function openBrowser(url) {
  if (process.platform !== "darwin") {
    return;
  }
  const child = spawn("open", [url], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
}

async function main() {
  const args = parseArgs(process.argv);
  const runtime = await startServer(args);
  console.log(`pi-ghost-dag: ${runtime.url}`);
  console.log(`cwd: ${runtime.cwd}`);
  console.log("Press Ctrl+C to stop.");
  if (args.open) {
    openBrowser(runtime.url);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

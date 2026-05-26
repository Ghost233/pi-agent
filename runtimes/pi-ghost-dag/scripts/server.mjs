#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  approveNode,
  getSnapshot,
  rerunTask,
  resolveTask,
  runNext,
  runUntilBlocked,
} from "./store.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD_DIR = path.resolve(SCRIPT_DIR, "../dashboard");

const MIME_TYPES = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function parseArgs(argv) {
  const args = {
    cwd: process.cwd(),
    host: "127.0.0.1",
    port: 7331,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cwd") {
      args.cwd = argv[++index];
    } else if (arg === "--host") {
      args.host = argv[++index];
    } else if (arg === "--port") {
      args.port = Number(argv[++index]);
    } else if (!arg.startsWith("-") && !args.positionalCwd) {
      args.cwd = arg;
      args.positionalCwd = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function sendJson(res, statusCode, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  });
  res.end(body);
}

function sendError(res, error) {
  sendJson(res, 500, {
    ok: false,
    error: error.message,
  });
}

function readRequestJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function apiContext(defaultCwd, url, body = {}) {
  return {
    cwd: path.resolve(body.cwd || url.searchParams.get("cwd") || defaultCwd),
    sessionId: body.session_id || body.sessionId || url.searchParams.get("session_id") || url.searchParams.get("sessionId") || "default",
  };
}

async function handleApi(req, res, defaultCwd, url) {
  const pathname = url.pathname;
  if (req.method === "GET" && pathname === "/api/state") {
    const context = apiContext(defaultCwd, url);
    sendJson(res, 200, {
      ok: true,
      data: getSnapshot(context.cwd, context.sessionId),
    });
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, {
      ok: false,
      error: "Method not allowed",
    });
    return;
  }

  const body = await readRequestJson(req);
  const context = apiContext(defaultCwd, url, body);
  let data;
  if (pathname === "/api/run-next") {
    data = runNext(context.cwd, context.sessionId);
  } else if (pathname === "/api/run-until-blocked") {
    data = runUntilBlocked(context.cwd, Number(body.limit) || 50, context.sessionId);
  } else if (pathname === "/api/approve") {
    data = approveNode(context.cwd, body.id, context.sessionId);
  } else if (pathname === "/api/resolve") {
    data = resolveTask(context.cwd, body.id, body.answer || "", context.sessionId);
  } else if (pathname === "/api/rerun") {
    data = rerunTask(context.cwd, body.id, context.sessionId);
  } else {
    sendJson(res, 404, {
      ok: false,
      error: "API route not found",
    });
    return;
  }
  sendJson(res, 200, {
    ok: true,
    data,
  });
}

function sendStatic(res, pathname) {
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(DASHBOARD_DIR, `.${safePath}`);
  if (!filePath.startsWith(DASHBOARD_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const ext = path.extname(filePath);
  res.writeHead(200, {
    "content-type": MIME_TYPES.get(ext) || "application/octet-stream",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  fs.createReadStream(filePath).pipe(res);
}

export function startServer(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const host = options.host || "127.0.0.1";
  const port = Number(options.port || 7331);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${host}:${port}`);
    handleRequest(req, res, cwd, url).catch((error) => sendError(res, error));
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve({
        server,
        cwd,
        host,
        port,
        url: `http://${host}:${server.address().port}/`,
      });
    });
  });
}

async function handleRequest(req, res, cwd, url) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    res.end();
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res, cwd, url);
    return;
  }
  sendStatic(res, url.pathname);
}

async function main() {
  const args = parseArgs(process.argv);
  const runtime = await startServer(args);
  console.log(`pi-ghost-dag: ${runtime.url}`);
  console.log(`cwd: ${runtime.cwd}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

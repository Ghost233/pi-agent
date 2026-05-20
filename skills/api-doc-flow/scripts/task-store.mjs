#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

function parseArgs(argv) {
  const command = argv[2];
  if (!command || command.startsWith("-")) {
    throw new Error("Usage: task-store.mjs <add|claim|finish|fail|done|status|current|requeue|validate> [options]");
  }

  const args = { command, cwd: process.cwd() };
  for (let index = 3; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cwd") {
      args.cwd = argv[++index];
    } else if (arg === "--groups") {
      args.groups = argv[++index];
    } else if (arg === "--state") {
      args.state = argv[++index];
    } else if (arg === "--id") {
      args.id = argv[++index];
    } else if (arg === "--status") {
      args.status = argv[++index];
    } else if (arg === "--reason") {
      args.reason = argv[++index];
    } else if (arg === "--from") {
      args.from = argv[++index];
    } else if (arg === "--task-json") {
      args.taskJson = argv[++index];
    } else if (arg === "--limit") {
      args.limit = Number(argv[++index]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) {
    return fallback;
  }
  return JSON.parse(raw);
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function normalizeState(state) {
  return {
    completed: Array.isArray(state.completed) ? state.completed : [],
    failed: Array.isArray(state.failed) ? state.failed : [],
    current: state.current ?? null,
    updated_at: state.updated_at ?? null,
  };
}

function failedIds(state) {
  return new Set(
    state.failed
      .map((item) => (typeof item === "string" ? item : item?.id))
      .filter(Boolean),
  );
}

function removeFailed(state, id) {
  state.failed = state.failed.filter((item) => {
    const failedId = typeof item === "string" ? item : item?.id;
    return failedId !== id;
  });
}

function removeCompleted(state, id) {
  state.completed = state.completed.filter((item) => item !== id);
}

function taskId(task) {
  return typeof task?.id === "string" && task.id.trim() ? task.id.trim() : null;
}

function isTaskClosedInState(task, state) {
  const id = taskId(task);
  if (!id) {
    return true;
  }
  return state.completed.includes(id) || failedIds(state).has(id);
}

function isTaskClosed(task, state) {
  if (task?.status === "done" || task?.status === "failed") {
    return true;
  }
  return isTaskClosedInState(task, state);
}

function resolveStatePath(cwd, explicitPath) {
  return path.resolve(cwd, explicitPath ?? ".pi-flow/state.json");
}

function resolveGroupsPath(cwd, explicitPath, forAdd = false) {
  if (explicitPath) {
    return path.resolve(cwd, explicitPath);
  }

  const ndjsonPath = path.join(cwd, ".pi-flow", "groups.ndjson");
  const jsonPath = path.join(cwd, ".pi-flow", "groups.json");
  if (fs.existsSync(ndjsonPath)) {
    return ndjsonPath;
  }
  if (fs.existsSync(jsonPath)) {
    return jsonPath;
  }
  return forAdd ? ndjsonPath : jsonPath;
}

function isNdjson(filePath) {
  return filePath.endsWith(".ndjson") || filePath.endsWith(".jsonl");
}

async function readTasksFromNdjson(filePath, onTask) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const input = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input, crlfDelay: Infinity });
  let lineNumber = 0;
  try {
    for await (const line of rl) {
      lineNumber += 1;
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      const task = JSON.parse(trimmed);
      const shouldContinue = await onTask(task, lineNumber);
      if (shouldContinue === false) {
        rl.close();
        input.destroy();
        break;
      }
    }
  } finally {
    rl.close();
  }
}

async function findNextTask(groupsPath, state) {
  if (isNdjson(groupsPath)) {
    let nextTask = null;
    await readTasksFromNdjson(groupsPath, (task) => {
      if (!isTaskClosed(task, state)) {
        nextTask = task;
        return false;
      }
      return true;
    });
    return nextTask;
  }

  const groups = readJson(groupsPath, []);
  if (!Array.isArray(groups)) {
    throw new Error(`${groupsPath} must contain a JSON array`);
  }
  return groups.find((task) => !isTaskClosed(task, state)) ?? null;
}

function currentTaskStillPending(task, state) {
  return task && !isTaskClosed(task, { ...state, current: null });
}

function output(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function readStdin() {
  if (process.stdin.isTTY) {
    return "";
  }
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseTaskInput(raw, sourceName) {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (parsed && typeof parsed === "object") {
      return [parsed];
    }
  } catch {
    // Fall through to NDJSON parsing.
  }

  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function loadTasksToAdd(args, cwd) {
  if (args.taskJson) {
    return parseTaskInput(args.taskJson, "--task-json");
  }
  if (args.from) {
    const fromPath = path.resolve(cwd, args.from);
    return parseTaskInput(fs.readFileSync(fromPath, "utf8"), args.from);
  }
  const stdin = await readStdin();
  return parseTaskInput(stdin, "stdin");
}

function assertValidTask(task) {
  const id = taskId(task);
  if (!id) {
    throw new Error(`Task is missing id: ${JSON.stringify(task)}`);
  }
  if (!Array.isArray(task.files) || task.files.length === 0) {
    throw new Error(`Task ${id} is missing files`);
  }
}

function appendTasksNdjson(groupsPath, tasks) {
  fs.mkdirSync(path.dirname(groupsPath), { recursive: true });
  const content = tasks.map((task) => JSON.stringify(task)).join("\n");
  fs.appendFileSync(groupsPath, `${content}\n`, "utf8");
}

function appendTasksJson(groupsPath, tasks) {
  const existing = readJson(groupsPath, []);
  if (!Array.isArray(existing)) {
    throw new Error(`${groupsPath} must contain a JSON array`);
  }
  writeJsonAtomic(groupsPath, [...existing, ...tasks]);
}

async function commandAdd(args) {
  const cwd = path.resolve(args.cwd);
  const groupsPath = resolveGroupsPath(cwd, args.groups, true);
  if (args.from && path.resolve(cwd, args.from) === groupsPath) {
    throw new Error("--from must not point to the same file as the task store");
  }
  const tasks = await loadTasksToAdd(args, cwd);
  tasks.forEach(assertValidTask);
  if (isNdjson(groupsPath)) {
    appendTasksNdjson(groupsPath, tasks);
  } else {
    appendTasksJson(groupsPath, tasks);
  }
  output({
    status: "ADDED",
    count: tasks.length,
    groups_path: path.relative(cwd, groupsPath),
  });
}

async function commandClaim(args) {
  const cwd = path.resolve(args.cwd);
  const groupsPath = resolveGroupsPath(cwd, args.groups);
  const statePath = resolveStatePath(cwd, args.state);

  if (!fs.existsSync(groupsPath)) {
    output({
      status: "BLOCKED_GROUPS_NOT_FOUND",
      groups_path: path.relative(cwd, groupsPath),
    });
    return;
  }

  const state = normalizeState(readJson(statePath, {}));
  if (currentTaskStillPending(state.current, state)) {
    output({
      status: "CLAIMED",
      resumed: true,
      task: state.current,
      state_path: path.relative(cwd, statePath),
      groups_path: path.relative(cwd, groupsPath),
    });
    return;
  }

  const task = await findNextTask(groupsPath, state);
  if (!task) {
    state.current = null;
    state.updated_at = new Date().toISOString();
    writeJsonAtomic(statePath, state);
    output({ status: "NO_PENDING_TASK" });
    return;
  }

  state.current = task;
  state.updated_at = new Date().toISOString();
  writeJsonAtomic(statePath, state);

  output({
    status: "CLAIMED",
    resumed: false,
    task,
    state_path: path.relative(cwd, statePath),
    groups_path: path.relative(cwd, groupsPath),
  });
}

function commandFinish(args) {
  const cwd = path.resolve(args.cwd);
  const statePath = resolveStatePath(cwd, args.state);
  const id = args.id;
  const status = args.command === "fail" ? "failed" : args.command === "done" ? "done" : args.status;

  if (!id) {
    throw new Error("--id is required");
  }
  if (status !== "done" && status !== "failed") {
    throw new Error('--status must be "done" or "failed"');
  }

  const state = normalizeState(readJson(statePath, {}));
  removeCompleted(state, id);
  removeFailed(state, id);

  if (status === "done") {
    state.completed.push(id);
  } else {
    state.failed.push({
      id,
      reason: args.reason || "No reason provided",
      failed_at: new Date().toISOString(),
    });
  }

  if (state.current?.id === id) {
    state.current = null;
  }
  state.updated_at = new Date().toISOString();
  writeJsonAtomic(statePath, state);

  output({
    status: status === "done" ? "DONE" : "FAILED",
    id,
    state_path: path.relative(cwd, statePath),
  });
}

function commandCurrent(args) {
  const cwd = path.resolve(args.cwd);
  const statePath = resolveStatePath(cwd, args.state);
  const state = normalizeState(readJson(statePath, {}));
  if (!state.current) {
    output({ status: "NO_CURRENT_TASK" });
    return;
  }
  output({
    status: "CURRENT",
    task: state.current,
    state_path: path.relative(cwd, statePath),
  });
}

function commandRequeue(args) {
  const cwd = path.resolve(args.cwd);
  const statePath = resolveStatePath(cwd, args.state);
  const id = args.id;
  if (!id) {
    throw new Error("--id is required");
  }
  const state = normalizeState(readJson(statePath, {}));
  removeCompleted(state, id);
  removeFailed(state, id);
  if (state.current?.id === id) {
    state.current = null;
  }
  state.updated_at = new Date().toISOString();
  writeJsonAtomic(statePath, state);
  output({
    status: "REQUEUED",
    id,
    state_path: path.relative(cwd, statePath),
  });
}

async function countTasks(groupsPath, state) {
  const counts = { total: 0, pending: 0, completed: 0, failed: 0, invalid: 0 };
  const countOne = (task) => {
    counts.total += 1;
    const id = taskId(task);
    if (!id) {
      counts.invalid += 1;
      return;
    }
    if (state.completed.includes(id) || task.status === "done") {
      counts.completed += 1;
    } else if (failedIds(state).has(id) || task.status === "failed") {
      counts.failed += 1;
    } else {
      counts.pending += 1;
    }
  };

  if (!fs.existsSync(groupsPath)) {
    return counts;
  }
  if (isNdjson(groupsPath)) {
    await readTasksFromNdjson(groupsPath, (task) => {
      countOne(task);
      return true;
    });
  } else {
    const groups = readJson(groupsPath, []);
    if (!Array.isArray(groups)) {
      throw new Error(`${groupsPath} must contain a JSON array`);
    }
    groups.forEach(countOne);
  }
  return counts;
}

async function commandStatus(args) {
  const cwd = path.resolve(args.cwd);
  const groupsPath = resolveGroupsPath(cwd, args.groups);
  const statePath = resolveStatePath(cwd, args.state);
  const state = normalizeState(readJson(statePath, {}));
  const counts = await countTasks(groupsPath, state);
  output({
    status: "STATUS",
    groups_path: path.relative(cwd, groupsPath),
    state_path: path.relative(cwd, statePath),
    current: state.current?.id ?? null,
    ...counts,
  });
}

function validateTask(task, line, cwd, seenIds, issues) {
  const id = taskId(task);
  const prefix = id ?? `line-${line}`;
  if (!id) {
    issues.push({ id: prefix, type: "missing_id" });
    return;
  }
  if (seenIds.has(id)) {
    issues.push({ id, type: "duplicate_id" });
  }
  seenIds.add(id);

  if (!Array.isArray(task.files) || task.files.length === 0) {
    issues.push({ id, type: "missing_files" });
  }
  for (const key of ["source_file", "generated_file"]) {
    if (!task[key]) {
      issues.push({ id, type: `missing_${key}` });
      continue;
    }
    if (path.isAbsolute(task[key])) {
      issues.push({ id, type: `absolute_${key}`, path: task[key] });
      continue;
    }
    if (!fs.existsSync(path.join(cwd, task[key]))) {
      issues.push({ id, type: `path_not_found_${key}`, path: task[key] });
    }
  }
}

async function commandValidate(args) {
  const cwd = path.resolve(args.cwd);
  const groupsPath = resolveGroupsPath(cwd, args.groups);
  const limit = Number.isFinite(args.limit) ? args.limit : 50;
  const seenIds = new Set();
  const issues = [];
  let total = 0;

  if (!fs.existsSync(groupsPath)) {
    output({
      status: "INVALID",
      groups_path: path.relative(cwd, groupsPath),
      issues: [{ type: "groups_not_found" }],
    });
    return;
  }

  const validateOne = (task, line = total + 1) => {
    total += 1;
    if (issues.length <= limit) {
      validateTask(task, line, cwd, seenIds, issues);
    }
  };

  if (isNdjson(groupsPath)) {
    await readTasksFromNdjson(groupsPath, (task, line) => {
      validateOne(task, line);
      return true;
    });
  } else {
    const groups = readJson(groupsPath, []);
    if (!Array.isArray(groups)) {
      throw new Error(`${groupsPath} must contain a JSON array`);
    }
    groups.forEach((task, index) => validateOne(task, index + 1));
  }

  output({
    status: issues.length === 0 ? "VALID" : "INVALID",
    groups_path: path.relative(cwd, groupsPath),
    total,
    issue_count: issues.length,
    issues: issues.slice(0, limit),
    truncated: issues.length > limit,
  });
}

async function main() {
  const args = parseArgs(process.argv);
  switch (args.command) {
    case "add":
      await commandAdd(args);
      break;
    case "claim":
      await commandClaim(args);
      break;
    case "finish":
    case "fail":
    case "done":
      commandFinish(args);
      break;
    case "current":
      commandCurrent(args);
      break;
    case "requeue":
      commandRequeue(args);
      break;
    case "status":
      await commandStatus(args);
      break;
    case "validate":
      await commandValidate(args);
      break;
    default:
      throw new Error(`Unknown command: ${args.command}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

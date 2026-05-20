#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const ALLOWED_DAG_NODE_TYPES = new Set([
  "group_api_docs",
  "map_group",
  "fix_one",
  "summarize_result",
]);

const ALLOWED_WORKERS = new Set(["api-doc-fix-one"]);

const TERMINAL_TASK_STATUSES = new Set(["done", "failed"]);
const TERMINAL_NODE_STATUSES = new Set(["done", "failed"]);

function parseArgs(argv) {
  const command = argv[2];
  if (!command || command.startsWith("-")) {
    throw new Error("Usage: task-store.mjs <add|claim|finish|fail|done|status|current|requeue|validate|dag-init|dag-next|dag-done|dag-fail|dag-status|validate-dag> [options]");
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
    } else if (arg === "--dag") {
      args.dag = argv[++index];
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
    } else if (arg === "--dag-json") {
      args.dagJson = argv[++index];
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
    dag: normalizeDagState(state.dag ?? {}),
    updated_at: state.updated_at ?? null,
  };
}

function normalizeDagState(dagState) {
  return {
    completed: Array.isArray(dagState.completed) ? dagState.completed : [],
    failed: Array.isArray(dagState.failed) ? dagState.failed : [],
    current: dagState.current ?? null,
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
  if (TERMINAL_TASK_STATUSES.has(task?.status)) {
    return true;
  }
  return isTaskClosedInState(task, state);
}

function resolveStatePath(cwd, explicitPath) {
  return path.resolve(cwd, explicitPath ?? ".pi-flow/state.json");
}

function resolveDagPath(cwd, explicitPath) {
  return path.resolve(cwd, explicitPath ?? ".pi-flow/dag.json");
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

async function loadDagInput(args, cwd) {
  if (args.dagJson) {
    return JSON.parse(args.dagJson);
  }
  if (args.from) {
    const fromPath = path.resolve(cwd, args.from);
    return readJson(fromPath, null);
  }
  const stdin = await readStdin();
  if (!stdin.trim()) {
    throw new Error("DAG input is required through --dag-json, --from, or stdin");
  }
  return JSON.parse(stdin);
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

function failedNodeIds(state) {
  return new Set(
    state.dag.failed
      .map((item) => (typeof item === "string" ? item : item?.id))
      .filter(Boolean),
  );
}

function removeFailedNode(state, id) {
  state.dag.failed = state.dag.failed.filter((item) => {
    const failedId = typeof item === "string" ? item : item?.id;
    return failedId !== id;
  });
}

function removeCompletedNode(state, id) {
  state.dag.completed = state.dag.completed.filter((item) => item !== id);
}

function nodeId(node) {
  return typeof node?.id === "string" && node.id.trim() ? node.id.trim() : null;
}

function nodeDeps(node) {
  return Array.isArray(node.depends_on) ? node.depends_on : [];
}

function nodeStatus(node, state) {
  const id = nodeId(node);
  if (!id) {
    return "invalid";
  }
  if (failedNodeIds(state).has(id) || node.status === "failed") {
    return "failed";
  }
  if (state.dag.completed.includes(id) || node.status === "done") {
    return "done";
  }
  if (state.dag.current?.id === id) {
    return "running";
  }
  return node.status === "running" ? "running" : "pending";
}

function nodeDone(node, state) {
  return nodeStatus(node, state) === "done";
}

function dependenciesDone(node, state, nodeMap) {
  return nodeDeps(node).every((depId) => {
    const dep = nodeMap.get(depId);
    return dep && nodeDone(dep, state);
  });
}

function markNodeDone(state, id) {
  removeCompletedNode(state, id);
  removeFailedNode(state, id);
  state.dag.completed.push(id);
  if (state.dag.current?.id === id) {
    state.dag.current = null;
  }
}

function markNodeFailed(state, id, reason) {
  removeCompletedNode(state, id);
  removeFailedNode(state, id);
  state.dag.failed.push({
    id,
    reason: reason || "No reason provided",
    failed_at: new Date().toISOString(),
  });
  if (state.dag.current?.id === id) {
    state.dag.current = null;
  }
}

function mapNodeGroupsPath(cwd, node, args) {
  const groupsPath = node?.input?.groups ?? args.groups;
  if (!groupsPath) {
    return resolveGroupsPath(cwd, undefined);
  }
  if (path.isAbsolute(groupsPath)) {
    throw new Error(`DAG node ${node.id} input.groups must be relative`);
  }
  return path.resolve(cwd, groupsPath);
}

function validateDagObject(dag, cwd, options = {}) {
  const issues = [];
  if (!dag || typeof dag !== "object" || Array.isArray(dag)) {
    return [{ type: "dag_must_be_object" }];
  }
  if (dag.version !== 1) {
    issues.push({ type: "unsupported_version", version: dag.version });
  }
  if (!Array.isArray(dag.nodes) || dag.nodes.length === 0) {
    issues.push({ type: "missing_nodes" });
    return issues;
  }

  const seenIds = new Set();
  const nodeMap = new Map();
  for (const node of dag.nodes) {
    const id = nodeId(node);
    if (!id) {
      issues.push({ type: "missing_node_id" });
      continue;
    }
    if (seenIds.has(id)) {
      issues.push({ id, type: "duplicate_node_id" });
    }
    seenIds.add(id);
    nodeMap.set(id, node);

    if (!ALLOWED_DAG_NODE_TYPES.has(node.type)) {
      issues.push({ id, type: "unsupported_node_type", node_type: node.type });
    }
    if (node.depends_on !== undefined && !Array.isArray(node.depends_on)) {
      issues.push({ id, type: "depends_on_must_be_array" });
    }
    if (node.status !== undefined && !["pending", "running", "done", "failed"].includes(node.status)) {
      issues.push({ id, type: "unsupported_status", status: node.status });
    }
    if (node.type === "map_group") {
      if (!ALLOWED_WORKERS.has(node.worker)) {
        issues.push({ id, type: "unsupported_worker", worker: node.worker });
      }
      if (!node.input?.groups) {
        issues.push({ id, type: "missing_groups_input" });
      } else if (path.isAbsolute(node.input.groups)) {
        issues.push({ id, type: "absolute_groups_input", path: node.input.groups });
      } else if (options.checkFiles && !fs.existsSync(path.resolve(cwd, node.input.groups))) {
        issues.push({ id, type: "groups_input_not_found", path: node.input.groups });
      }
    }
  }

  for (const node of dag.nodes) {
    const id = nodeId(node);
    if (!id) {
      continue;
    }
    for (const depId of nodeDeps(node)) {
      if (!nodeMap.has(depId)) {
        issues.push({ id, type: "missing_dependency", dependency: depId });
      }
    }
  }

  const visiting = new Set();
  const visited = new Set();
  const visit = (id, stack) => {
    if (visited.has(id)) {
      return;
    }
    if (visiting.has(id)) {
      issues.push({ id, type: "cycle", path: [...stack, id] });
      return;
    }
    visiting.add(id);
    const node = nodeMap.get(id);
    for (const depId of nodeDeps(node)) {
      if (nodeMap.has(depId)) {
        visit(depId, [...stack, id]);
      }
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of nodeMap.keys()) {
    visit(id, []);
  }

  return issues;
}

async function commandDagInit(args) {
  const cwd = path.resolve(args.cwd);
  const dagPath = resolveDagPath(cwd, args.dag);
  const statePath = resolveStatePath(cwd, args.state);
  const dag = await loadDagInput(args, cwd);
  const issues = validateDagObject(dag, cwd, { checkFiles: true });
  if (issues.length > 0) {
    output({
      status: "INVALID_DAG",
      issue_count: issues.length,
      issues,
    });
    process.exitCode = 1;
    return;
  }

  writeJsonAtomic(dagPath, dag);
  const state = normalizeState({});
  state.updated_at = new Date().toISOString();
  writeJsonAtomic(statePath, state);
  output({
    status: "DAG_INITIALIZED",
    dag_path: path.relative(cwd, dagPath),
    state_path: path.relative(cwd, statePath),
    nodes: dag.nodes.length,
  });
}

async function commandValidateDag(args) {
  const cwd = path.resolve(args.cwd);
  const dagPath = resolveDagPath(cwd, args.dag);
  const limit = Number.isFinite(args.limit) ? args.limit : 50;
  if (!fs.existsSync(dagPath)) {
    output({
      status: "INVALID_DAG",
      dag_path: path.relative(cwd, dagPath),
      issues: [{ type: "dag_not_found" }],
    });
    return;
  }
  const dag = readJson(dagPath, null);
  const issues = validateDagObject(dag, cwd, { checkFiles: true });
  output({
    status: issues.length === 0 ? "VALID_DAG" : "INVALID_DAG",
    dag_path: path.relative(cwd, dagPath),
    node_count: Array.isArray(dag?.nodes) ? dag.nodes.length : 0,
    issue_count: issues.length,
    issues: issues.slice(0, limit),
    truncated: issues.length > limit,
  });
}

async function commandDagStatus(args) {
  const cwd = path.resolve(args.cwd);
  const dagPath = resolveDagPath(cwd, args.dag);
  const statePath = resolveStatePath(cwd, args.state);
  if (!fs.existsSync(dagPath)) {
    output({
      status: "BLOCKED_DAG_NOT_FOUND",
      dag_path: path.relative(cwd, dagPath),
    });
    return;
  }
  const dag = readJson(dagPath, null);
  const issues = validateDagObject(dag, cwd, { checkFiles: false });
  if (issues.length > 0) {
    output({
      status: "INVALID_DAG",
      dag_path: path.relative(cwd, dagPath),
      issue_count: issues.length,
      issues,
    });
    return;
  }
  const state = normalizeState(readJson(statePath, {}));
  const nodeMap = new Map(dag.nodes.map((node) => [node.id, node]));
  const nodes = [];
  for (const node of dag.nodes) {
    const summary = {
      id: node.id,
      type: node.type,
      status: nodeStatus(node, state),
      depends_on: nodeDeps(node),
    };
    if (node.type === "map_group") {
      const groupsPath = mapNodeGroupsPath(cwd, node, args);
      summary.worker = node.worker;
      summary.groups_path = path.relative(cwd, groupsPath);
      summary.tasks = await countTasks(groupsPath, state);
    }
    summary.ready = summary.status === "pending" && dependenciesDone(node, state, nodeMap);
    nodes.push(summary);
  }
  output({
    status: "DAG_STATUS",
    dag_path: path.relative(cwd, dagPath),
    state_path: path.relative(cwd, statePath),
    current: state.dag.current?.id ?? null,
    nodes,
  });
}

async function commandDagNext(args) {
  const cwd = path.resolve(args.cwd);
  const dagPath = resolveDagPath(cwd, args.dag);
  const statePath = resolveStatePath(cwd, args.state);
  if (!fs.existsSync(dagPath)) {
    output({
      status: "BLOCKED_DAG_NOT_FOUND",
      dag_path: path.relative(cwd, dagPath),
    });
    return;
  }

  const dag = readJson(dagPath, null);
  const issues = validateDagObject(dag, cwd, { checkFiles: true });
  if (issues.length > 0) {
    output({
      status: "INVALID_DAG",
      dag_path: path.relative(cwd, dagPath),
      issue_count: issues.length,
      issues,
    });
    return;
  }

  const state = normalizeState(readJson(statePath, {}));
  const nodeMap = new Map(dag.nodes.map((node) => [node.id, node]));

  if (state.dag.current) {
    const currentNode = nodeMap.get(state.dag.current.id);
    if (currentNode && !TERMINAL_NODE_STATUSES.has(nodeStatus(currentNode, state))) {
      output({
        status: "DAG_NEXT",
        resumed: true,
        action: state.dag.current.action,
        node: state.dag.current,
        state_path: path.relative(cwd, statePath),
      });
      return;
    }
    state.dag.current = null;
  }

  for (const node of dag.nodes) {
    const id = nodeId(node);
    const status = nodeStatus(node, state);
    if (!id || status === "done") {
      continue;
    }
    if (status === "failed") {
      output({
        status: "DAG_BLOCKED",
        reason: "node_failed",
        node: { id, type: node.type },
      });
      return;
    }
    if (!dependenciesDone(node, state, nodeMap)) {
      continue;
    }

    if (node.type === "map_group") {
      const groupsPath = mapNodeGroupsPath(cwd, node, args);
      if (!fs.existsSync(groupsPath)) {
        output({
          status: "BLOCKED_GROUPS_NOT_FOUND",
          node: { id, type: node.type },
          groups_path: path.relative(cwd, groupsPath),
        });
        return;
      }
      const counts = await countTasks(groupsPath, state);
      if (counts.failed > 0) {
        output({
          status: "DAG_BLOCKED",
          reason: "map_group_has_failed_tasks",
          node: { id, type: node.type, worker: node.worker },
          groups_path: path.relative(cwd, groupsPath),
          tasks: counts,
        });
        return;
      }
      if (counts.pending > 0) {
        output({
          status: "DAG_NEXT",
          resumed: false,
          action: "run_worker",
          node: { id, type: node.type, worker: node.worker },
          groups_path: path.relative(cwd, groupsPath),
          tasks: counts,
        });
        return;
      }
      if (counts.total === 0) {
        output({
          status: "DAG_BLOCKED",
          reason: "map_group_has_no_tasks",
          node: { id, type: node.type, worker: node.worker },
          groups_path: path.relative(cwd, groupsPath),
        });
        return;
      }
      markNodeDone(state, id);
      state.updated_at = new Date().toISOString();
      writeJsonAtomic(statePath, state);
      continue;
    }

    state.dag.current = {
      id,
      type: node.type,
      action: node.type,
      input: node.input ?? {},
    };
    state.updated_at = new Date().toISOString();
    writeJsonAtomic(statePath, state);
    output({
      status: "DAG_NEXT",
      resumed: false,
      action: node.type,
      node: state.dag.current,
      state_path: path.relative(cwd, statePath),
    });
    return;
  }

  state.dag.current = null;
  state.updated_at = new Date().toISOString();
  writeJsonAtomic(statePath, state);
  output({
    status: "DAG_DONE",
    dag_path: path.relative(cwd, dagPath),
    state_path: path.relative(cwd, statePath),
  });
}

function commandDagFinish(args) {
  const cwd = path.resolve(args.cwd);
  const statePath = resolveStatePath(cwd, args.state);
  const id = args.id;
  if (!id) {
    throw new Error("--id is required");
  }

  const state = normalizeState(readJson(statePath, {}));
  if (args.command === "dag-done") {
    markNodeDone(state, id);
  } else {
    markNodeFailed(state, id, args.reason);
  }
  state.updated_at = new Date().toISOString();
  writeJsonAtomic(statePath, state);
  output({
    status: args.command === "dag-done" ? "DAG_NODE_DONE" : "DAG_NODE_FAILED",
    id,
    state_path: path.relative(cwd, statePath),
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
    case "dag-init":
      await commandDagInit(args);
      break;
    case "dag-next":
      await commandDagNext(args);
      break;
    case "dag-done":
    case "dag-fail":
      commandDagFinish(args);
      break;
    case "dag-status":
      await commandDagStatus(args);
      break;
    case "validate-dag":
      await commandValidateDag(args);
      break;
    default:
      throw new Error(`Unknown command: ${args.command}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const FLOW_DIR = ".pi-flow";
const SESSIONS_DIR = "sessions";
const TASKS_FILE = "tasks.ndjson";
const DAG_FILE = "dag.json";
const STATE_FILE = "state.json";

const CLOSED_TASK_STATUSES = new Set(["done", "failed", "skipped"]);
const STOP_TASK_STATUSES = new Set(["blocked", "waiting_review"]);

function now() {
  return new Date().toISOString();
}

function safeRunId() {
  return `${now().replace(/[:.]/g, "-")}-${Math.random().toString(16).slice(2, 8)}`;
}

function resolveRoot(cwd = process.cwd()) {
  return path.resolve(cwd);
}

function safeSegment(value) {
  return String(value || "default").replace(/[^a-zA-Z0-9_.-]/g, "_").slice(0, 96) || "default";
}

export function flowPaths(cwd = process.cwd(), sessionId = "default") {
  const root = resolveRoot(cwd);
  const safeSessionId = safeSegment(sessionId);
  const flowDir = safeSessionId === "default"
    ? path.join(root, FLOW_DIR)
    : path.join(root, FLOW_DIR, SESSIONS_DIR, safeSessionId);
  return {
    root,
    session_id: safeSessionId,
    flowDir,
    dag: path.join(flowDir, DAG_FILE),
    tasks: path.join(flowDir, TASKS_FILE),
    state: path.join(flowDir, STATE_FILE),
    runs: path.join(flowDir, "runs"),
  };
}

function readJson(filePath, defaultValue) {
  if (!fs.existsSync(filePath)) {
    return defaultValue;
  }
  const raw = fs.readFileSync(filePath, "utf8").trim();
  return raw ? JSON.parse(raw) : defaultValue;
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function writeTextAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, value, "utf8");
  fs.renameSync(tempPath, filePath);
}

function readTasks(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function writeTasks(filePath, tasks) {
  const body = tasks.map((task) => JSON.stringify(task)).join("\n");
  writeTextAtomic(filePath, body ? `${body}\n` : "");
}

function normalizeDag(dag) {
  if (Array.isArray(dag)) {
    return {
      version: 1,
      name: "DAG",
      nodes: dag,
    };
  }
  return {
    version: dag?.version ?? 1,
    name: dag?.name ?? "DAG",
    created_at: dag?.created_at ?? null,
    updated_at: dag?.updated_at ?? null,
    nodes: Array.isArray(dag?.nodes) ? dag.nodes : [],
  };
}

function emptyState() {
  return {
    version: 1,
    dag: {
      completed: [],
      failed: [],
      blocked: [],
      waiting_review: [],
      current: null,
    },
    tasks: {
      current: null,
    },
    events: [],
    updated_at: now(),
  };
}

function normalizeState(state) {
  const base = emptyState();
  return {
    version: state?.version ?? 1,
    dag: {
      completed: Array.isArray(state?.dag?.completed) ? state.dag.completed : base.dag.completed,
      failed: Array.isArray(state?.dag?.failed) ? state.dag.failed : base.dag.failed,
      blocked: Array.isArray(state?.dag?.blocked) ? state.dag.blocked : base.dag.blocked,
      waiting_review: Array.isArray(state?.dag?.waiting_review) ? state.dag.waiting_review : base.dag.waiting_review,
      current: state?.dag?.current ?? null,
    },
    tasks: {
      current: state?.tasks?.current ?? null,
    },
    events: Array.isArray(state?.events) ? state.events.slice(-200) : [],
    updated_at: state?.updated_at ?? now(),
  };
}

function uniquePush(list, id) {
  if (!list.includes(id)) {
    list.push(id);
  }
}

function removeId(list, id) {
  return list.filter((item) => item !== id);
}

function recordEvent(state, type, payload = {}) {
  state.events.push({
    type,
    payload,
    at: now(),
  });
  state.events = state.events.slice(-200);
  state.updated_at = now();
}

function load(cwd, sessionId) {
  const paths = flowPaths(cwd, sessionId);
  return {
    paths,
    dag: normalizeDag(readJson(paths.dag, null)),
    tasks: readTasks(paths.tasks),
    state: normalizeState(readJson(paths.state, null)),
  };
}

function saveDag(paths, dag) {
  const nextDag = {
    ...dag,
    updated_at: now(),
  };
  writeJsonAtomic(paths.dag, nextDag);
  return nextDag;
}

function saveState(paths, state) {
  state.updated_at = now();
  writeJsonAtomic(paths.state, state);
}

function taskCounts(tasks) {
  const counts = {
    total: tasks.length,
    pending: 0,
    ready: 0,
    running: 0,
    done: 0,
    failed: 0,
    blocked: 0,
    waiting_review: 0,
    skipped: 0,
  };
  for (const task of tasks) {
    const status = task.status || "pending";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function taskById(tasks, id) {
  return tasks.find((task) => task.id === id);
}

function nodeById(nodes, id) {
  return nodes.find((node) => node.id === id);
}

function nodeStatus(node, state) {
  if (state.dag.completed.includes(node.id) || node.status === "done") {
    return "done";
  }
  if (state.dag.failed.includes(node.id) || node.status === "failed") {
    return "failed";
  }
  if (state.dag.blocked.includes(node.id) || node.status === "blocked") {
    return "blocked";
  }
  if (state.dag.waiting_review.includes(node.id) || node.status === "waiting_review") {
    return "waiting_review";
  }
  if (state.dag.current === node.id || node.status === "running") {
    return "running";
  }
  return node.status || "pending";
}

function depsDone(node, dag, state) {
  const deps = node.depends_on || node.dependsOn || [];
  return deps.every((id) => {
    const depNode = nodeById(dag.nodes, id);
    return depNode && nodeStatus(depNode, state) === "done";
  });
}

function markNodeDone(dag, state, id) {
  const node = nodeById(dag.nodes, id);
  if (node) {
    node.status = "done";
  }
  state.dag.current = null;
  state.dag.blocked = removeId(state.dag.blocked, id);
  state.dag.waiting_review = removeId(state.dag.waiting_review, id);
  uniquePush(state.dag.completed, id);
}

function markNodeWaitingReview(dag, state, id) {
  const node = nodeById(dag.nodes, id);
  if (node) {
    node.status = "waiting_review";
  }
  state.dag.current = null;
  uniquePush(state.dag.waiting_review, id);
}

function markNodeRunning(dag, state, id) {
  const node = nodeById(dag.nodes, id);
  if (node) {
    node.status = "running";
  }
  state.dag.current = id;
}

function writeRun(paths, entityId, result) {
  const runId = safeRunId();
  const runDir = path.join(paths.runs, entityId, runId);
  fs.mkdirSync(runDir, { recursive: true });
  writeJsonAtomic(path.join(runDir, "metadata.json"), {
    id: runId,
    entity_id: entityId,
    status: result.status,
    created_at: now(),
  });
  writeJsonAtomic(path.join(runDir, "result.json"), result);
  writeTextAtomic(path.join(runDir, "log.md"), `${result.summary || result.message || result.status}\n`);
  writeTextAtomic(path.join(runDir, "diff.patch"), result.diff || "");
  return { run_id: runId, run_dir: path.relative(paths.root, runDir) };
}

function latestRuns(paths) {
  if (!fs.existsSync(paths.runs)) {
    return [];
  }
  const rows = [];
  for (const entity of fs.readdirSync(paths.runs)) {
    const entityDir = path.join(paths.runs, entity);
    if (!fs.statSync(entityDir).isDirectory()) {
      continue;
    }
    const runIds = fs.readdirSync(entityDir).filter((name) => fs.statSync(path.join(entityDir, name)).isDirectory()).sort();
    const latest = runIds.at(-1);
    if (!latest) {
      continue;
    }
    const resultPath = path.join(entityDir, latest, "result.json");
    rows.push({
      entity_id: entity,
      run_id: latest,
      result: readJson(resultPath, {}),
    });
  }
  return rows.sort((a, b) => String(b.run_id).localeCompare(String(a.run_id)));
}

export function getSnapshot(cwd = process.cwd(), sessionId = "default") {
  const { paths, dag, tasks, state } = load(cwd, sessionId);
  const nodes = dag.nodes.map((node) => ({
    ...node,
    status: nodeStatus(node, state),
    ready: nodeStatus(node, state) === "pending" && depsDone(node, dag, state),
  }));
  return {
    cwd: paths.root,
    session_id: paths.session_id,
    flow_dir: path.relative(paths.root, paths.flowDir),
    exists: fs.existsSync(paths.dag),
    dag: {
      ...dag,
      nodes,
    },
    task_counts: taskCounts(tasks),
    tasks,
    state,
    runs: latestRuns(paths),
  };
}

export function approveNode(cwd, id, sessionId = "default") {
  const { paths, dag, state } = load(cwd, sessionId);
  const node = nodeById(dag.nodes, id);
  if (!node) {
    throw new Error(`Node not found: ${id}`);
  }
  markNodeDone(dag, state, id);
  recordEvent(state, "node_approved", { id });
  saveDag(paths, dag);
  saveState(paths, state);
  return getSnapshot(cwd, sessionId);
}

export function resolveTask(cwd, id, answer, sessionId = "default") {
  const { paths, tasks, state } = load(cwd, sessionId);
  const task = taskById(tasks, id);
  if (!task) {
    throw new Error(`Task not found: ${id}`);
  }
  task.status = "pending";
  task.resolution = {
    answer: answer || "",
    resolved_at: now(),
  };
  delete task.blocked_at;
  state.tasks.current = null;
  recordEvent(state, "task_resolved", { id, answer: answer || "" });
  writeTasks(paths.tasks, tasks);
  saveState(paths, state);
  return getSnapshot(cwd, sessionId);
}

export function rerunTask(cwd, id, sessionId = "default") {
  const { paths, tasks, state } = load(cwd, sessionId);
  const task = taskById(tasks, id);
  if (!task) {
    throw new Error(`Task not found: ${id}`);
  }
  task.status = "pending";
  delete task.completed_at;
  delete task.failed_at;
  delete task.blocked_at;
  delete task.result;
  recordEvent(state, "task_requeued", { id });
  writeTasks(paths.tasks, tasks);
  saveState(paths, state);
  return getSnapshot(cwd, sessionId);
}

function findReadyNode(dag, state) {
  return dag.nodes.find((node) => {
    const status = nodeStatus(node, state);
    if (status !== "pending") {
      return false;
    }
    return depsDone(node, dag, state);
  });
}

function firstOpenTask(tasks) {
  return tasks.find((task) => {
    const status = task.status || "pending";
    return !CLOSED_TASK_STATUSES.has(status) && !STOP_TASK_STATUSES.has(status) && status !== "running";
  });
}

export function runNext(cwd = process.cwd(), sessionId = "default") {
  const { paths, dag, tasks, state } = load(cwd, sessionId);
  if (!fs.existsSync(paths.dag)) {
    return {
      status: "NO_DAG",
      message: "Create a DAG first.",
      snapshot: getSnapshot(cwd, sessionId),
    };
  }

  const waitingNode = dag.nodes.find((node) => nodeStatus(node, state) === "waiting_review");
  if (waitingNode) {
    return {
      status: "WAITING_REVIEW",
      node: waitingNode,
      question: waitingNode.question || "Review is required before continuing.",
      snapshot: getSnapshot(cwd, sessionId),
    };
  }

  const blockedTask = tasks.find((task) => task.status === "blocked");
  if (blockedTask) {
    return {
      status: "TASK_BLOCKED",
      task: blockedTask,
      question: blockedTask.question || "This task needs a user decision.",
      snapshot: getSnapshot(cwd, sessionId),
    };
  }

  let readyNode = null;
  if (state.dag.current) {
    const currentNode = nodeById(dag.nodes, state.dag.current);
    if (currentNode && currentNode.type === "map" && nodeStatus(currentNode, state) === "running") {
      readyNode = currentNode;
    }
  }
  if (!readyNode) {
    readyNode = findReadyNode(dag, state);
  }
  if (!readyNode) {
    const allDone = dag.nodes.length > 0 && dag.nodes.every((node) => nodeStatus(node, state) === "done");
    return {
      status: allDone ? "DAG_DONE" : "DAG_BLOCKED",
      snapshot: getSnapshot(cwd, sessionId),
    };
  }

  if (readyNode.type === "human_review") {
    markNodeWaitingReview(dag, state, readyNode.id);
    recordEvent(state, "node_waiting_review", { id: readyNode.id });
    saveDag(paths, dag);
    saveState(paths, state);
    return {
      status: "WAITING_REVIEW",
      node: readyNode,
      question: readyNode.question || "Review is required before continuing.",
      snapshot: getSnapshot(cwd, sessionId),
    };
  }

  if (readyNode.type === "map") {
    markNodeRunning(dag, state, readyNode.id);
    const task = firstOpenTask(tasks);
    if (!task) {
      const counts = taskCounts(tasks);
      if (counts.blocked > 0 || counts.waiting_review > 0 || counts.failed > 0) {
        readyNode.status = "blocked";
        uniquePush(state.dag.blocked, readyNode.id);
        recordEvent(state, "map_blocked", { id: readyNode.id, counts });
        saveDag(paths, dag);
        saveState(paths, state);
        return {
          status: "DAG_BLOCKED",
          node: readyNode,
          counts,
          snapshot: getSnapshot(cwd, sessionId),
        };
      }
      markNodeDone(dag, state, readyNode.id);
      recordEvent(state, "map_done", { id: readyNode.id });
      saveDag(paths, dag);
      saveState(paths, state);
      return {
        status: "NODE_DONE",
        node: readyNode,
        snapshot: getSnapshot(cwd, sessionId),
      };
    }

    task.status = "running";
    task.started_at = now();
    task.attempts = (task.attempts || 0) + 1;
    state.tasks.current = task.id;

    if (task.requires_decision && !task.resolution) {
      task.status = "blocked";
      task.blocked_at = now();
      const result = {
        status: "blocked",
        task_id: task.id,
        summary: task.question || "Task needs a user decision.",
        question: task.question,
        options: task.options || [],
      };
      const run = writeRun(paths, task.id, result);
      task.result = result;
      task.latest_run = run;
      state.tasks.current = null;
      recordEvent(state, "task_blocked", { id: task.id, question: task.question });
      writeTasks(paths.tasks, tasks);
      saveDag(paths, dag);
      saveState(paths, state);
      return {
        status: "TASK_BLOCKED",
        task,
        run,
        snapshot: getSnapshot(cwd, sessionId),
      };
    }

    task.status = "done";
    task.completed_at = now();
    const result = {
      status: "done",
      task_id: task.id,
      changed_file: task.generated_file || null,
      summary: "MVP simulation completed this task. Pi worker integration can replace this step.",
      uncertainty: task.resolution ? `User answer: ${task.resolution.answer}` : null,
    };
    const run = writeRun(paths, task.id, result);
    task.result = result;
    task.latest_run = run;
    state.tasks.current = null;
    recordEvent(state, "task_done", { id: task.id });
    writeTasks(paths.tasks, tasks);
    saveDag(paths, dag);
    saveState(paths, state);
    return {
      status: "TASK_DONE",
      task,
      run,
      snapshot: getSnapshot(cwd, sessionId),
    };
  }

  if (readyNode.type === "summary") {
    markNodeRunning(dag, state, readyNode.id);
    const result = {
      status: "done",
      node_id: readyNode.id,
      summary: "All runnable tasks are complete.",
      task_counts: taskCounts(tasks),
    };
    const run = writeRun(paths, readyNode.id, result);
    markNodeDone(dag, state, readyNode.id);
    recordEvent(state, "summary_done", { id: readyNode.id });
    saveDag(paths, dag);
    saveState(paths, state);
    return {
      status: "NODE_DONE",
      node: readyNode,
      run,
      snapshot: getSnapshot(cwd, sessionId),
    };
  }

  markNodeDone(dag, state, readyNode.id);
  recordEvent(state, "node_done", { id: readyNode.id, type: readyNode.type });
  saveDag(paths, dag);
  saveState(paths, state);
  return {
    status: "NODE_DONE",
    node: readyNode,
    snapshot: getSnapshot(cwd, sessionId),
  };
}

export function runUntilBlocked(cwd = process.cwd(), limit = 50, sessionId = "default") {
  const results = [];
  for (let index = 0; index < limit; index += 1) {
    const result = runNext(cwd, sessionId);
    results.push({
      status: result.status,
      node: result.node?.id,
      task: result.task?.id,
    });
    if (["WAITING_REVIEW", "TASK_BLOCKED", "DAG_BLOCKED", "DAG_DONE", "NO_DAG"].includes(result.status)) {
      return {
        status: result.status,
        results,
        snapshot: getSnapshot(cwd, sessionId),
      };
    }
  }
  return {
    status: "LIMIT_REACHED",
    results,
    snapshot: getSnapshot(cwd, sessionId),
  };
}

function parseArgs(argv) {
  const args = {
    command: argv[2],
    cwd: process.cwd(),
  };
  for (let index = 3; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cwd") {
      args.cwd = argv[++index];
    } else if (arg === "--session") {
      args.session = argv[++index];
    } else if (arg === "--id") {
      args.id = argv[++index];
    } else if (arg === "--answer") {
      args.answer = argv[++index];
    } else if (arg === "--limit") {
      args.limit = Number(argv[++index]);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.command) {
    throw new Error("Usage: store.mjs <status|run-next|run-until-blocked|approve|resolve|rerun> [options]");
  }
  let result;
  if (args.command === "status") {
    result = getSnapshot(args.cwd, args.session);
  } else if (args.command === "run-next") {
    result = runNext(args.cwd, args.session);
  } else if (args.command === "run-until-blocked") {
    result = runUntilBlocked(args.cwd, args.limit || 50, args.session);
  } else if (args.command === "approve") {
    result = approveNode(args.cwd, args.id, args.session);
  } else if (args.command === "resolve") {
    result = resolveTask(args.cwd, args.id, args.answer || "", args.session);
  } else if (args.command === "rerun") {
    result = rerunTask(args.cwd, args.id, args.session);
  } else {
    throw new Error(`Unknown command: ${args.command}`);
  }
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}

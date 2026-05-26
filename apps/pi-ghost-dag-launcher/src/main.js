import { Terminal } from "./vendor/xterm/xterm.mjs";
import { FitAddon } from "./vendor/xterm/addon-fit.mjs";

const isTauriRuntime = Boolean(window.__TAURI__?.core?.invoke);
const invoke = isTauriRuntime ? window.__TAURI__.core.invoke : createBrowserInvoke();
const WORKSPACES_KEY = "pi-ghost-dag.workspaces";
const SELECTED_WORKSPACE_KEY = "pi-ghost-dag.selectedWorkspace";
const SESSIONS_KEY = "pi-ghost-dag.sessions";
const SELECTED_SESSION_KEY = "pi-ghost-dag.selectedSession";
const LAYOUT_KEY = "pi-ghost-dag.layout";
const GRAPH_VIEW_KEY = "pi-ghost-dag.graphView";
const ORCHESTRATOR_MODE_KEY = "pi-ghost-dag.orchestratorMode";
const ORCHESTRATOR_COMMAND_KEY = "pi-ghost-dag.orchestratorCommand";
const REFRESH_INTERVAL_MS = 2500;
const urlParams = new URLSearchParams(window.location.search);
const INITIAL_CWD = urlParams.get("cwd") || "";
const BROWSER_SERVICE_URL = !isTauriRuntime && /^https?:$/.test(window.location.protocol)
  ? window.location.origin.replace(/\/+$/, "")
  : "";

const els = {
  cwd: document.querySelector("#cwd"),
  port: document.querySelector("#port"),
  orchestratorCommand: document.querySelector("#orchestrator-command"),
  status: document.querySelector("#status-pill"),
  projectPanel: document.querySelector("#project-panel"),
  projectMenuToggle: document.querySelector("#project-menu-toggle"),
  projectMenu: document.querySelector("#project-menu"),
  createProject: document.querySelector("#create-project"),
  useFolder: document.querySelector("#use-folder"),
  dropHint: document.querySelector("#drop-hint"),
  start: document.querySelector("#start"),
  forceStop: document.querySelector("#force-stop"),
  openBrowser: document.querySelector("#open-browser"),
  refresh: document.querySelector("#refresh"),
  restartApp: document.querySelector("#restart-app"),
  mainShell: document.querySelector("#main-shell"),
  openServerSettings: document.querySelector("#open-server-settings"),
  closeServerSettings: document.querySelector("#close-server-settings"),
  removeWorkspace: document.querySelector("#remove-workspace"),
  clearLogs: document.querySelector("#clear-logs"),
  currentTitle: document.querySelector("#current-title"),
  currentPath: document.querySelector("#current-path"),
  workspaceCount: document.querySelector("#workspace-count"),
  workspaces: document.querySelector("#workspaces"),
  dagName: document.querySelector("#dag-name"),
  dagGraph: document.querySelector("#dag-graph"),
  nodeCount: document.querySelector("#node-count"),
  nodeDetail: document.querySelector("#node-detail"),
  nodeList: document.querySelector("#node-list"),
  taskSummary: document.querySelector("#task-summary"),
  taskList: document.querySelector("#task-list"),
  dagSelection: document.querySelector("#dag-selection"),
  zoomOut: document.querySelector("#dag-zoom-out"),
  zoomReset: document.querySelector("#dag-zoom-reset"),
  zoomIn: document.querySelector("#dag-zoom-in"),
  selectMode: document.querySelector("#dag-select-mode"),
  copyNode: document.querySelector("#copy-node"),
  sidebarResizer: document.querySelector("#sidebar-resizer"),
  inspectorResizer: document.querySelector("#inspector-resizer"),
  taskResizer: document.querySelector("#task-resizer"),
  bottomResizer: document.querySelector("#bottom-resizer"),
  blocker: document.querySelector("#blocker"),
  logs: document.querySelector("#logs"),
  runs: document.querySelector("#runs"),
  events: document.querySelector("#events"),
  orchestratorStatus: document.querySelector("#orchestrator-status"),
  orchestratorModeStructured: document.querySelector("#orchestrator-mode-structured"),
  orchestratorModeTerminal: document.querySelector("#orchestrator-mode-terminal"),
  orchestratorRenew: document.querySelector("#orchestrator-renew"),
  orchestratorStructured: document.querySelector("#orchestrator-structured"),
  orchestratorStructuredLog: document.querySelector("#orchestrator-structured-log"),
  orchestratorInput: document.querySelector("#orchestrator-input"),
  orchestratorSend: document.querySelector("#orchestrator-send"),
  orchestratorTerminalWrap: document.querySelector("#orchestrator-terminal-wrap"),
  orchestratorTerminal: document.querySelector("#orchestrator-terminal"),
  orchestratorWorkspace: document.querySelector("#orchestrator-workspace"),
  settingsServiceStatus: document.querySelector("#settings-service-status"),
  settingsServicePid: document.querySelector("#settings-service-pid"),
  settingsServiceUrl: document.querySelector("#settings-service-url"),
  settingsServiceLog: document.querySelector("#settings-service-log"),
};

const STATUS_LABELS = {
  running: "运行中",
  stopped: "已停止",
  pending: "待处理",
  ready: "就绪",
  done: "已完成",
  failed: "失败",
  blocked: "已阻塞",
  waiting_review: "待确认",
  skipped: "已跳过",
  unknown: "未知",
};

const TYPE_LABELS = {
  planner: "规划",
  review: "审核",
  map: "批处理",
  worker: "执行",
  summary: "汇总",
  node: "节点",
};

const state = {
  status: null,
  logs: [],
  snapshot: null,
  selectedNodeId: null,
  selectedNodeIds: new Set(),
  selectedWorkspace: localStorage.getItem(SELECTED_WORKSPACE_KEY) || "",
  selectedSessionId: localStorage.getItem(SELECTED_SESSION_KEY) || "",
  workspaces: readWorkspaces(),
  sessions: readSessions(),
  layout: readLayout(),
  graphView: readGraphView(),
  graphLayout: null,
  graphSelectMode: false,
  graphDrag: null,
  graphSelectionRect: null,
  orchestratorMode: localStorage.getItem(ORCHESTRATOR_MODE_KEY) || "structured",
  orchestratorCommand: localStorage.getItem(ORCHESTRATOR_COMMAND_KEY) || "",
  terminal: null,
  terminalFit: null,
  terminalSocket: null,
  terminalConnected: false,
  terminalConnecting: false,
  terminalResizeObserver: null,
  orchestrator: null,
  orchestratorEnsuring: false,
  orchestratorSending: false,
  orchestratorAutoStartedFor: "",
  serviceStartFailed: false,
  lastAction: "idle",
  busy: false,
};

function browserServiceStatus() {
  const port = Number(window.location.port || 0) || 7331;
  return {
    running: true,
    pid: null,
    cwd: null,
    port,
    server_script: "pi-ghost-dag-server",
    orchestrator_command: localStorage.getItem(ORCHESTRATOR_COMMAND_KEY) || null,
    url: `${BROWSER_SERVICE_URL}/`,
    log_path: null,
  };
}

function createBrowserInvoke() {
  return async (command, payload = {}) => {
    if (command === "start_service") {
      if (payload.request?.orchestrator_command) {
        localStorage.setItem(ORCHESTRATOR_COMMAND_KEY, payload.request.orchestrator_command);
      }
      return browserServiceStatus();
    }
    if (command === "stop_workspace" || command === "stop_service" || command === "force_stop_service") {
      throw new Error("浏览器模式不能停止后台服务，请在 Launcher 应用中停止。");
    }
    if (command === "status_for_workspace" || command === "status") {
      return browserServiceStatus();
    }
    if (command === "logs_for_workspace" || command === "logs") {
      return [];
    }
    if (command === "clear_logs_for_workspace" || command === "clear_logs") {
      return null;
    }
    if (command === "open_dashboard_for_workspace" || command === "open_dashboard") {
      const cwd = payload.cwd || currentWorkspace();
      const session = payload.sessionId || sessionId();
      const url = new URL(window.location.href);
      if (cwd) {
        url.searchParams.set("cwd", cwd);
      }
      url.searchParams.set("session_id", session);
      window.location.href = url.toString();
      return null;
    }
    if (command === "open_orchestrator_terminal") {
      throw new Error("浏览器模式已内嵌终端，不支持打开系统终端。");
    }
    if (command === "restart_ui") {
      window.location.reload();
      return null;
    }
    throw new Error(`浏览器模式不支持命令: ${command}`);
  };
}

function readWorkspaces() {
  try {
    const parsed = JSON.parse(localStorage.getItem(WORKSPACES_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function saveWorkspaces() {
  localStorage.setItem(WORKSPACES_KEY, JSON.stringify(state.workspaces));
  localStorage.setItem(SELECTED_WORKSPACE_KEY, state.selectedWorkspace || "");
}

function readSessions() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSIONS_KEY) || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function readLayout() {
  const defaults = {
    sidebarWidth: 284,
    inspectorWidth: 330,
    taskHeight: 178,
    bottomHeight: 320,
  };
  try {
    const parsed = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}");
    const layout = { ...defaults, ...(parsed && typeof parsed === "object" ? parsed : {}) };
    if (!parsed?.bottomHeight || parsed.bottomHeight < 280) {
      layout.bottomHeight = defaults.bottomHeight;
    }
    return layout;
  } catch {
    return defaults;
  }
}

function saveLayout() {
  localStorage.setItem(LAYOUT_KEY, JSON.stringify(state.layout));
}

function applyLayout() {
  const root = document.documentElement;
  root.style.setProperty("--sidebar-width", `${state.layout.sidebarWidth}px`);
  root.style.setProperty("--inspector-width", `${state.layout.inspectorWidth}px`);
  root.style.setProperty("--task-height", `${state.layout.taskHeight}px`);
  root.style.setProperty("--bottom-height", `${state.layout.bottomHeight}px`);
}

function readGraphView() {
  const defaults = { x: 24, y: 24, scale: 1 };
  try {
    const parsed = JSON.parse(localStorage.getItem(GRAPH_VIEW_KEY) || "{}");
    return {
      x: Number.isFinite(parsed?.x) ? parsed.x : defaults.x,
      y: Number.isFinite(parsed?.y) ? parsed.y : defaults.y,
      scale: Number.isFinite(parsed?.scale) ? clamp(parsed.scale, 0.25, 2.5) : defaults.scale,
    };
  } catch {
    return defaults;
  }
}

function saveGraphView() {
  localStorage.setItem(GRAPH_VIEW_KEY, JSON.stringify(state.graphView));
}

function saveSessions() {
  localStorage.setItem(SESSIONS_KEY, JSON.stringify(state.sessions));
  localStorage.setItem(SELECTED_SESSION_KEY, state.selectedSessionId || "");
}

function setProjectMenu(open) {
  els.projectMenu.classList.toggle("hidden", !open);
  els.projectMenuToggle.classList.toggle("active", open);
}

function normalizePath(value) {
  return String(value || "").trim();
}

function normalizeDroppedPath(value) {
  const text = normalizePath(value);
  if (!text) {
    return "";
  }
  try {
    if (text.startsWith("file://")) {
      return decodeURIComponent(new URL(text).pathname);
    }
  } catch {
    return text;
  }
  return text;
}

function currentWorkspace() {
  return normalizePath(els.cwd.value || state.selectedWorkspace);
}

function currentOrchestratorCommand() {
  return normalizePath(els.orchestratorCommand?.value || state.orchestratorCommand);
}

function saveOrchestratorCommand() {
  state.orchestratorCommand = currentOrchestratorCommand();
  localStorage.setItem(ORCHESTRATOR_COMMAND_KEY, state.orchestratorCommand);
}

function sessionId() {
  return state.selectedSessionId || "default";
}

function sessionsFor(workspace = state.selectedWorkspace) {
  const key = normalizePath(workspace);
  if (!key) {
    return [];
  }
  if (!Array.isArray(state.sessions[key]) || state.sessions[key].length === 0) {
    state.sessions[key] = [createSessionRecord("默认会话", "default")];
  }
  return state.sessions[key];
}

function storedSessionsFor(workspace = state.selectedWorkspace) {
  const key = normalizePath(workspace);
  const sessions = state.sessions[key];
  return Array.isArray(sessions) ? sessions : [];
}

function createSessionRecord(title, id = null) {
  const createdAt = new Date().toISOString();
  return {
    id: id || `thread-${createdAt.replace(/[:.]/g, "-")}`,
    title,
    created_at: createdAt,
  };
}

function currentSession() {
  return sessionsFor().find((item) => item.id === sessionId()) || sessionsFor()[0] || null;
}

function basename(value) {
  const clean = normalizePath(value).replace(/\/+$/, "");
  return clean.split("/").filter(Boolean).pop() || clean || "未选择工作区";
}

function setBusy(isBusy) {
  state.busy = isBusy;
  for (const button of document.querySelectorAll("button")) {
    button.disabled = isBusy;
  }
  if (!isBusy) {
    applyServiceButtonState();
    renderOrchestratorLaunch();
  }
}

function setButtonLabel(button, label) {
  const span = button?.querySelector("span");
  if (span) {
    span.textContent = label;
  }
}

function setButtonIcon(button, iconClass) {
  const icon = button?.querySelector("i");
  if (icon) {
    icon.className = `ti ${iconClass}`;
  }
}

function applyServiceButtonState() {
  const running = Boolean(state.status?.running);
  els.start.disabled = state.busy;
  els.forceStop.disabled = state.busy;
  els.forceStop.classList.toggle("hidden", running || !state.serviceStartFailed || !isTauriRuntime);
  els.start.classList.add("primary");
  setButtonLabel(els.start, running ? "停止" : "启动");
  setButtonIcon(els.start, running ? "ti-player-stop" : "ti-player-play");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function statusClass(status) {
  return String(status || "pending").replace(/[^a-z0-9_-]/gi, "_");
}

function statusLabel(status) {
  const value = status || "pending";
  return STATUS_LABELS[value] || value;
}

function typeLabel(type) {
  const value = type || "node";
  return TYPE_LABELS[value] || value;
}

function badge(status) {
  const value = status || "pending";
  return `<span class="badge ${statusClass(value)}">${escapeHtml(statusLabel(value))}</span>`;
}

function truncate(value, length = 22) {
  const text = String(value ?? "");
  return text.length > length ? `${text.slice(0, length - 1)}...` : text;
}

function selectedNodes() {
  const nodes = state.snapshot?.dag?.nodes || [];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return [...state.selectedNodeIds].map((id) => byId.get(id)).filter(Boolean);
}

function setSelectedNodes(ids, primaryId = null) {
  const unique = [...new Set(ids.filter(Boolean))];
  state.selectedNodeIds = new Set(unique);
  state.selectedNodeId = primaryId || unique[0] || null;
}

function syncSelectionWithNodes(nodes) {
  const validIds = new Set(nodes.map((node) => node.id));
  const kept = [...state.selectedNodeIds].filter((id) => validIds.has(id));
  if (kept.length === 0) {
    const defaultNodeId = defaultSelectedNode(nodes)?.id || null;
    setSelectedNodes(defaultNodeId ? [defaultNodeId] : [], defaultNodeId);
    return;
  }
  const primary = kept.includes(state.selectedNodeId) ? state.selectedNodeId : kept[0];
  setSelectedNodes(kept, primary);
}

function updateDagToolbar() {
  const nodes = selectedNodes();
  const count = nodes.length;
  els.dagSelection.textContent = count === 0 ? "未选择" : `已选 ${count}`;
  els.copyNode.disabled = state.busy || count === 0;
  els.selectMode.classList.toggle("active", state.graphSelectMode);
  setButtonLabel(els.zoomReset, `${Math.round(state.graphView.scale * 100)}%`);
}

function nodeInfoForCopy(node) {
  return {
    id: node.id,
    title: node.title || node.id,
    type: node.type || "node",
    status: node.status || "pending",
    status_label: statusLabel(node.status),
    depends_on: nodeDependencies(node),
    question: node.question || null,
    ready: Boolean(node.ready),
  };
}

async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  document.execCommand("copy");
  area.remove();
}

async function copySelectedNodeInfo() {
  const nodes = selectedNodes();
  if (nodes.length === 0) {
    return;
  }
  const payload = nodes.length === 1
    ? nodeInfoForCopy(nodes[0])
    : nodes.map(nodeInfoForCopy);
  await writeClipboard(JSON.stringify(payload, null, 2));
  setButtonLabel(els.copyNode, "已复制");
  setTimeout(() => setButtonLabel(els.copyNode, "复制节点"), 900);
}

function renderWorkspaces() {
  els.workspaceCount.textContent = String(state.workspaces.length);
  if (state.workspaces.length === 0) {
    els.workspaces.innerHTML = '<div class="empty">点右上角“添加”，或把目录拖进这里。</div>';
    return;
  }
  els.workspaces.innerHTML = state.workspaces
    .map((workspace) => {
      const activeWorkspace = workspace === state.selectedWorkspace;
      const sessions = storedSessionsFor(workspace);
      const sessionMarkup = sessions.length > 0
        ? sessions.map((session) => `
          <button class="session-item ${activeWorkspace && session.id === sessionId() ? "active" : ""}" data-workspace="${escapeHtml(workspace)}" data-session-id="${escapeHtml(session.id)}">
            <strong>${escapeHtml(session.title || session.id)}</strong>
            <span>${escapeHtml(session.id)}</span>
          </button>
        `).join("")
        : '<div class="workspace-empty">暂无对话</div>';
      return `
        <div class="workspace-group ${activeWorkspace ? "active" : ""}">
          <div class="workspace-header">
            <button class="workspace-item" data-workspace="${escapeHtml(workspace)}">
              <i class="ti ti-folder"></i>
              <span>
                <strong>${escapeHtml(basename(workspace))}</strong>
                <small>${escapeHtml(workspace)}</small>
              </span>
            </button>
            <button class="workspace-new-session" data-new-session="${escapeHtml(workspace)}" title="新会话"><i class="ti ti-edit"></i></button>
          </div>
          <div class="workspace-sessions">${sessionMarkup}</div>
        </div>
      `;
    })
    .join("");
}

function selectWorkspace(workspace) {
  disconnectOrchestratorTerminal();
  state.orchestrator = null;
  state.selectedWorkspace = normalizePath(workspace);
  els.cwd.value = state.selectedWorkspace;
  const sessions = sessionsFor(state.selectedWorkspace);
  if (!sessions.some((item) => item.id === state.selectedSessionId)) {
    state.selectedSessionId = sessions[0]?.id || "default";
  }
  saveWorkspaces();
  saveSessions();
  renderShell();
}

function selectSession(id) {
  disconnectOrchestratorTerminal();
  state.orchestrator = null;
  state.selectedSessionId = id || "default";
  state.selectedNodeId = null;
  state.selectedNodeIds = new Set();
  saveSessions();
  renderShell();
}

function addWorkspacePath(value) {
  const workspace = normalizeDroppedPath(value);
  if (!workspace) {
    return;
  }
  state.workspaces = [workspace, ...state.workspaces.filter((item) => item !== workspace)].slice(0, 20);
  sessionsFor(workspace);
  selectWorkspace(workspace);
}

function addWorkspace() {
  addWorkspacePath(els.cwd.value);
}

function removeWorkspace() {
  const workspace = normalizePath(els.cwd.value || state.selectedWorkspace);
  state.workspaces = state.workspaces.filter((item) => item !== workspace);
  delete state.sessions[workspace];
  state.selectedWorkspace = state.workspaces[0] || "";
  els.cwd.value = state.selectedWorkspace;
  state.selectedSessionId = sessionsFor(state.selectedWorkspace)[0]?.id || "";
  saveWorkspaces();
  saveSessions();
  renderShell();
}

function addSession(workspaceValue = currentWorkspace()) {
  const workspace = normalizePath(workspaceValue);
  if (!workspace) {
    return;
  }
  if (!state.workspaces.includes(workspace)) {
    state.workspaces = [workspace, ...state.workspaces].slice(0, 20);
    state.selectedWorkspace = workspace;
    els.cwd.value = workspace;
  }
  const sessions = sessionsFor(workspace);
  const nextIndex = sessions.length + 1;
  const session = createSessionRecord(`新会话 ${nextIndex}`);
  state.sessions[workspace] = [session, ...sessions];
  state.selectedSessionId = session.id;
  saveWorkspaces();
  saveSessions();
  renderShell();
}

function renderShell() {
  const workspace = currentWorkspace();
  const session = currentSession();
  const running = Boolean(state.status?.running);
  els.status.textContent = statusLabel(running ? "running" : "stopped");
  els.status.className = `pill ${running ? "running" : "stopped"}`;
  els.currentTitle.textContent = workspace
    ? `${basename(workspace)} / ${session?.title || "默认会话"}`
    : "未选择工作区";
  els.currentPath.classList.remove("error");
  if (running && workspace) {
    const pidText = state.status.pid ? ` · 全局服务 pid ${state.status.pid}` : " · 全局服务运行中";
    els.currentPath.textContent = `${workspace} · ${sessionId()}${pidText}`;
  } else if (running) {
    const pidText = state.status.pid ? ` pid ${state.status.pid}` : "";
    els.currentPath.textContent = `全局服务运行中${pidText}，选择工作区后查看 DAG。`;
  } else {
    els.currentPath.textContent = workspace
      ? `${workspace} · ${sessionId()} · 全局服务未启动`
      : "服务是全局后台进程；可以先启动服务，再选择工作区和会话。";
  }
  if (!state.orchestratorCommand && state.status?.orchestrator_command) {
    state.orchestratorCommand = state.status.orchestrator_command;
    localStorage.setItem(ORCHESTRATOR_COMMAND_KEY, state.orchestratorCommand);
  }
  if (els.orchestratorCommand && document.activeElement !== els.orchestratorCommand) {
    els.orchestratorCommand.value = state.orchestratorCommand;
  }
  if (state.status?.port) {
    els.port.value = String(state.status.port);
  }
  els.settingsServiceStatus.textContent = statusLabel(running ? "running" : "stopped");
  els.settingsServicePid.textContent = state.status?.pid ? String(state.status.pid) : "-";
  els.settingsServiceUrl.textContent = state.status?.url || "-";
  els.settingsServiceLog.textContent = state.status?.log_path || "-";
  applyServiceButtonState();
  renderWorkspaces();
  renderOrchestratorLaunch();
}

function setMainView(view) {
  const isSettings = view === "settings";
  els.mainShell.classList.toggle("settings-mode", isSettings);
}

function serviceBaseUrl() {
  return state.status?.url ? state.status.url.replace(/\/$/, "") : "";
}

function serviceWebSocketUrl(path) {
  const base = serviceBaseUrl();
  if (!base) {
    throw new Error("服务未启动");
  }
  const workspace = currentWorkspace();
  if (!workspace) {
    throw new Error("未选择工作区");
  }
  const url = new URL(path, `${base}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("cwd", workspace);
  url.searchParams.set("session_id", sessionId());
  return url.toString();
}

async function serviceApi(path, options = {}) {
  const base = serviceBaseUrl();
  if (!base) {
    throw new Error("服务未启动");
  }
  const workspace = currentWorkspace();
  if (!workspace) {
    throw new Error("未选择工作区");
  }
  const session = sessionId();
  const isGet = !options.method || options.method === "GET";
  const url = new URL(`${base}${path}`);
  if (isGet) {
    url.searchParams.set("cwd", workspace);
    url.searchParams.set("session_id", session);
  }
  const body = options.body
    ? { ...options.body, cwd: workspace, session_id: session }
    : isGet ? undefined : { cwd: workspace, session_id: session };
  const response = await fetch(url.toString(), {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json();
  if (!payload.ok) {
    throw new Error(payload.error || "请求失败");
  }
  return payload.data;
}

function nodeDependencies(node) {
  return node.depends_on || node.dependsOn || [];
}

function defaultSelectedNode(nodes) {
  return (
    nodes.find((node) => ["blocked", "waiting_review", "running"].includes(node.status)) ||
    nodes.find((node) => node.ready) ||
    nodes[0] ||
    null
  );
}

function relatedNodeIds(nodes, selectedId) {
  if (!selectedId) {
    return new Set();
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const related = new Set([selectedId]);
  const walkUp = (id) => {
    const node = byId.get(id);
    if (!node) {
      return;
    }
    for (const dep of nodeDependencies(node)) {
      if (!related.has(dep)) {
        related.add(dep);
        walkUp(dep);
      }
    }
  };
  const walkDown = (id) => {
    for (const node of nodes) {
      if (nodeDependencies(node).includes(id) && !related.has(node.id)) {
        related.add(node.id);
        walkDown(node.id);
      }
    }
  };
  walkUp(selectedId);
  walkDown(selectedId);
  return related;
}

function buildNodeGraph(nodes) {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const levelCache = new Map();

  function levelFor(node, seen = new Set()) {
    if (!node || seen.has(node.id)) {
      return 0;
    }
    if (levelCache.has(node.id)) {
      return levelCache.get(node.id);
    }
    seen.add(node.id);
    const deps = nodeDependencies(node).map((id) => byId.get(id)).filter(Boolean);
    const level = deps.length === 0 ? 0 : Math.max(...deps.map((dep) => levelFor(dep, seen))) + 1;
    seen.delete(node.id);
    levelCache.set(node.id, level);
    return level;
  }

  const groups = new Map();
  for (const node of nodes) {
    const level = levelFor(node);
    if (!groups.has(level)) {
      groups.set(level, []);
    }
    groups.get(level).push(node);
  }

  const positions = new Map();
  const nodeWidth = 178;
  const nodeHeight = 76;
  const levelGap = 236;
  const rowGap = 108;
  const margin = 34;
  let maxLevel = 0;
  let maxRows = 1;

  for (const [level, group] of groups) {
    maxLevel = Math.max(maxLevel, level);
    maxRows = Math.max(maxRows, group.length);
    group.forEach((node, row) => {
      positions.set(node.id, {
        x: margin + level * levelGap,
        y: margin + row * rowGap,
        width: nodeWidth,
        height: nodeHeight,
      });
    });
  }

  return {
    byId,
    positions,
    width: Math.max(620, margin * 2 + nodeWidth + maxLevel * levelGap),
    height: Math.max(260, margin * 2 + nodeHeight + (maxRows - 1) * rowGap),
  };
}

function graphViewport() {
  const rect = els.dagGraph.getBoundingClientRect();
  return {
    width: Math.max(1, Math.floor(rect.width)),
    height: Math.max(1, Math.floor(rect.height)),
  };
}

function graphPointFromEvent(event) {
  const rect = els.dagGraph.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function screenToWorld(point) {
  return {
    x: (point.x - state.graphView.x) / state.graphView.scale,
    y: (point.y - state.graphView.y) / state.graphView.scale,
  };
}

function normalizeRect(start, end) {
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  return {
    x,
    y,
    width: Math.abs(end.x - start.x),
    height: Math.abs(end.y - start.y),
  };
}

function rectsIntersect(a, b) {
  return a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y;
}

function nodeScreenRect(nodeId) {
  const pos = state.graphLayout?.positions?.get(nodeId);
  if (!pos) {
    return null;
  }
  return {
    x: state.graphView.x + pos.x * state.graphView.scale,
    y: state.graphView.y + pos.y * state.graphView.scale,
    width: pos.width * state.graphView.scale,
    height: pos.height * state.graphView.scale,
  };
}

function selectedNodeIdsInRect(rect) {
  const nodes = state.snapshot?.dag?.nodes || [];
  return nodes
    .filter((node) => {
      const nodeRect = nodeScreenRect(node.id);
      return nodeRect && rectsIntersect(rect, nodeRect);
    })
    .map((node) => node.id);
}

function updateGraphTransform() {
  const viewport = els.dagGraph.querySelector(".graph-viewport");
  if (viewport) {
    viewport.setAttribute("transform", `translate(${state.graphView.x} ${state.graphView.y}) scale(${state.graphView.scale})`);
  }
  updateDagToolbar();
}

function zoomGraphAt(nextScale, origin = null) {
  const scale = clamp(nextScale, 0.25, 2.5);
  const point = origin || {
    x: els.dagGraph.clientWidth / 2,
    y: els.dagGraph.clientHeight / 2,
  };
  const before = screenToWorld(point);
  state.graphView.scale = scale;
  state.graphView.x = point.x - before.x * scale;
  state.graphView.y = point.y - before.y * scale;
  saveGraphView();
  updateGraphTransform();
}

function resetGraphView() {
  state.graphView = { x: 24, y: 24, scale: 1 };
  saveGraphView();
  updateGraphTransform();
}

function renderDag(snapshot) {
  const dag = snapshot?.dag || { nodes: [] };
  const nodes = dag.nodes || [];
  els.dagName.textContent = dag.name || "未创建";
  els.nodeCount.textContent = String(nodes.length);

  syncSelectionWithNodes(nodes);

  if (nodes.length === 0) {
    els.dagGraph.innerHTML = '<div class="empty">启动服务后，在“编排者”里创建 DAG。</div>';
    els.nodeDetail.innerHTML = '<div class="empty">暂无节点。</div>';
    els.nodeList.innerHTML = "";
    state.graphLayout = null;
    setSelectedNodes([]);
    updateDagToolbar();
    return;
  }

  const selectedId = state.selectedNodeId;
  const selectedIds = state.selectedNodeIds;
  const related = relatedNodeIds(nodes, selectedId);
  const graph = buildNodeGraph(nodes);
  state.graphLayout = graph;
  const viewport = graphViewport();
  const edges = nodes.flatMap((node) => nodeDependencies(node).map((dep) => ({ from: dep, to: node.id })));
  const edgeMarkup = edges
    .map((edge) => {
      const from = graph.positions.get(edge.from);
      const to = graph.positions.get(edge.to);
      if (!from || !to) {
        return "";
      }
      const active = edge.from === selectedId || edge.to === selectedId || (related.has(edge.from) && related.has(edge.to));
      const startX = from.x + from.width;
      const startY = from.y + from.height / 2;
      const endX = to.x;
      const endY = to.y + to.height / 2;
      const midX = startX + Math.max(36, (endX - startX) / 2);
      return `<path class="graph-edge ${active ? "active" : ""}" d="M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}" />`;
    })
    .join("");

  const nodeMarkup = nodes
    .map((node) => {
      const pos = graph.positions.get(node.id);
      const selected = selectedIds.has(node.id);
      const dimmed = selectedIds.size <= 1 && selectedId && !related.has(node.id);
      const subtitle = node.type === "map"
        ? `${typeLabel(node.type)} · ${snapshot.task_counts?.done || 0}/${snapshot.task_counts?.total || 0}`
        : typeLabel(node.type);
      return `
        <g class="graph-node ${statusClass(node.status)} ${node.ready ? "ready" : ""} ${selected ? "selected" : ""} ${selected && selectedIds.size > 1 ? "multi-selected" : ""} ${dimmed ? "dimmed" : ""}" data-node-id="${escapeHtml(node.id)}" transform="translate(${pos.x} ${pos.y})">
          <rect width="${pos.width}" height="${pos.height}" rx="8"></rect>
          <text class="graph-title" x="14" y="24">${escapeHtml(truncate(node.title || node.id, 21))}</text>
          <text class="graph-id" x="14" y="45">${escapeHtml(truncate(node.id, 24))}</text>
          <text class="graph-meta" x="14" y="64">${escapeHtml(truncate(`${statusLabel(node.status)} · ${subtitle}`, 28))}</text>
        </g>
      `;
    })
    .join("");
  const selection = state.graphSelectionRect;
  const selectionMarkup = selection
    ? `<rect class="graph-selection" x="${selection.x}" y="${selection.y}" width="${selection.width}" height="${selection.height}"></rect>`
    : "";

  els.dagGraph.innerHTML = `
    <svg class="dag-canvas" viewBox="0 0 ${viewport.width} ${viewport.height}" preserveAspectRatio="none">
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z"></path>
        </marker>
      </defs>
      <g class="graph-viewport" transform="translate(${state.graphView.x} ${state.graphView.y}) scale(${state.graphView.scale})">
        <g>${edgeMarkup}</g>
        <g>${nodeMarkup}</g>
      </g>
      ${selectionMarkup}
    </svg>
  `;

  const selected = graph.byId.get(selectedId);
  renderNodeDetail(snapshot, selected);
  renderNodeList(nodes, selectedId);
  updateDagToolbar();
}

function renderNodeDetail(snapshot, node) {
  if (!node) {
    els.nodeDetail.innerHTML = '<div class="empty">选择图中的节点查看详情。</div>';
    return;
  }
  const deps = nodeDependencies(node);
  const children = (snapshot.dag?.nodes || [])
    .filter((candidate) => nodeDependencies(candidate).includes(node.id))
    .map((candidate) => candidate.id);
  els.nodeDetail.innerHTML = `
    <div class="node-detail-header">
      <div>
        <strong>${escapeHtml(node.title || node.id)}</strong>
        <span>${escapeHtml(node.id)}</span>
      </div>
      ${badge(node.status)}
    </div>
    <div class="detail-grid">
      <div><label>类型</label><strong>${escapeHtml(typeLabel(node.type))}</strong></div>
      <div><label>依赖</label><strong>${escapeHtml(deps.join(", ") || "无")}</strong></div>
      <div><label>下游</label><strong>${escapeHtml(children.join(", ") || "无")}</strong></div>
      <div><label>任务</label><strong>${node.type === "map" ? `${snapshot.task_counts?.done || 0} / ${snapshot.task_counts?.total || 0}` : "-"}</strong></div>
    </div>
    ${node.question ? `<p class="node-question">${escapeHtml(node.question)}</p>` : ""}
  `;
}

function renderNodeList(nodes, selectedId) {
  els.nodeList.innerHTML = nodes
    .map((node) => `
      <button class="node-row ${statusClass(node.status)} ${state.selectedNodeIds.has(node.id) ? "active" : ""}" data-node-id="${escapeHtml(node.id)}">
        ${badge(node.status)}
        <span>${escapeHtml(node.title || node.id)}</span>
      </button>
    `)
    .join("");
}

function renderTasks(snapshot) {
  const counts = snapshot?.task_counts || {};
  const tasks = snapshot?.tasks || [];
  els.taskSummary.textContent = `${counts.done || 0} / ${counts.total || 0}`;
  if (tasks.length === 0) {
    els.taskList.innerHTML = '<div class="empty">暂无任务。</div>';
    return;
  }
  els.taskList.innerHTML = tasks
    .map((task) => `
      <div class="task-row">
        ${badge(task.status)}
        <div>
          <strong>${escapeHtml(task.id)}</strong>
          <span>${escapeHtml(task.generated_file || task.source_file || "")}</span>
        </div>
      </div>
    `)
    .join("");
}

function findBlocker(snapshot) {
  const reviewNode = (snapshot?.dag?.nodes || []).find((node) => node.status === "waiting_review");
  if (reviewNode) {
    return {
      type: "review",
      id: reviewNode.id,
      text: reviewNode.question || "这个节点需要人工确认。",
      options: ["确认继续"],
    };
  }
  const blockedTask = (snapshot?.tasks || []).find((task) => task.status === "blocked");
  if (blockedTask) {
    return {
      type: "task",
      id: blockedTask.id,
      text: blockedTask.question || "这个任务需要人工决策。",
      options: blockedTask.options || ["继续"],
    };
  }
  return null;
}

function renderBlocker(snapshot) {
  const blocker = findBlocker(snapshot);
  if (!blocker) {
    els.blocker.classList.add("hidden");
    els.blocker.innerHTML = "";
    return;
  }
  els.blocker.classList.remove("hidden");
  els.blocker.innerHTML = `
    <strong>${escapeHtml(blocker.id)}</strong>
    <p>${escapeHtml(blocker.text)}</p>
    <div class="blocker-actions">
      ${blocker.options.map((option) => `<button class="primary" data-blocker-type="${blocker.type}" data-blocker-id="${escapeHtml(blocker.id)}" data-answer="${escapeHtml(option)}">${escapeHtml(option)}</button>`).join("")}
    </div>
  `;
}

function renderLogs(lines) {
  els.logs.textContent = lines.join("\n");
  els.logs.scrollTop = els.logs.scrollHeight;
}

function renderRuns(snapshot) {
  const runs = snapshot?.runs || [];
  els.runs.innerHTML = runs.slice(0, 30)
    .map((run) => `
      <div class="run-row">
        ${badge(run.result?.status || "unknown")}
        <div>
          <strong>${escapeHtml(run.entity_id)}</strong>
          <span>${escapeHtml(run.result?.summary || run.run_id)}</span>
        </div>
      </div>
    `)
    .join("") || '<div class="empty">暂无运行记录。</div>';
}

function renderEvents(snapshot) {
  const events = (snapshot?.state?.events || []).slice().reverse();
  els.events.innerHTML = events.slice(0, 40)
    .map((event) => `
      <div class="event-row">
        <strong>${escapeHtml(event.type)}</strong>
        <span>${escapeHtml(event.at)}</span>
      </div>
    `)
    .join("") || '<div class="empty">暂无事件。</div>';
}

function fitOrchestratorTerminal() {
  if (!state.terminal || !state.terminalFit || state.orchestratorMode !== "terminal") {
    return;
  }
  if (!els.orchestratorTerminalWrap || els.orchestratorTerminalWrap.classList.contains("hidden")) {
    return;
  }
  try {
    state.terminalFit.fit();
    sendTerminalResize();
  } catch (error) {
    console.warn("terminal fit failed", error);
  }
}

function sendTerminalMessage(payload) {
  const socket = state.terminalSocket;
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(payload));
}

function sendTerminalResize() {
  if (!state.terminal || !state.terminalConnected) {
    return;
  }
  sendTerminalMessage({ type: "resize", ...terminalSizePayload() });
}

function terminalSizePayload() {
  const rect = els.orchestratorTerminal?.getBoundingClientRect();
  return {
    cols: state.terminal?.cols || 100,
    rows: state.terminal?.rows || 28,
    pixel_width: rect ? Math.max(1, Math.floor(rect.width)) : 0,
    pixel_height: rect ? Math.max(1, Math.floor(rect.height)) : 0,
  };
}

function initOrchestratorTerminal() {
  if (state.terminal || !els.orchestratorTerminal) {
    return;
  }
  state.terminal = new Terminal({
    cursorBlink: true,
    fontFamily: '"SFMono-Regular", Menlo, Monaco, Consolas, monospace',
    fontSize: 12,
    lineHeight: 1.2,
    scrollback: 5000,
    convertEol: true,
    theme: {
      background: "#08090a",
      foreground: "#e8eaed",
      cursor: "#6aa6ff",
      selectionBackground: "#264f78",
      black: "#1d1f21",
      red: "#ff6b6b",
      green: "#63d471",
      yellow: "#f1c40f",
      blue: "#6aa6ff",
      magenta: "#c792ea",
      cyan: "#5dd8d8",
      white: "#e8eaed",
    },
  });
  state.terminalFit = new FitAddon();
  state.terminal.loadAddon(state.terminalFit);
  state.terminal.open(els.orchestratorTerminal);
  state.terminal.onData((data) => {
    sendTerminalMessage({ type: "input", data });
  });
  state.terminal.onResize(() => sendTerminalResize());
  if (!state.terminalResizeObserver && window.ResizeObserver && els.orchestratorTerminalWrap) {
    state.terminalResizeObserver = new ResizeObserver(() => fitOrchestratorTerminal());
    state.terminalResizeObserver.observe(els.orchestratorTerminalWrap);
  }
  requestAnimationFrame(fitOrchestratorTerminal);
}

async function writeTerminalEvent(data) {
  if (!state.terminal) {
    return;
  }
  if (typeof data === "string") {
    state.terminal.write(data);
    return;
  }
  if (data instanceof Blob) {
    const buffer = await data.arrayBuffer();
    state.terminal.write(new Uint8Array(buffer));
    return;
  }
  if (data instanceof ArrayBuffer) {
    state.terminal.write(new Uint8Array(data));
  }
}

function connectOrchestratorTerminal() {
  if (state.terminalConnected || state.terminalConnecting) {
    return;
  }
  if (!state.status?.running || !currentWorkspace()) {
    return;
  }
  state.orchestratorMode = "terminal";
  localStorage.setItem(ORCHESTRATOR_MODE_KEY, state.orchestratorMode);
  initOrchestratorTerminal();
  fitOrchestratorTerminal();
  state.terminalConnecting = true;
  renderOrchestratorLaunch();
  const url = new URL(serviceWebSocketUrl("/api/orchestrator/ws"));
  const size = terminalSizePayload();
  url.searchParams.set("cols", String(size.cols));
  url.searchParams.set("rows", String(size.rows));
  const socket = new WebSocket(url.toString());
  socket.binaryType = "arraybuffer";
  state.terminalSocket = socket;
  socket.addEventListener("open", () => {
    state.terminalConnected = true;
    state.terminalConnecting = false;
    renderOrchestratorLaunch();
    fitOrchestratorTerminal();
    state.terminal?.focus();
  });
  socket.addEventListener("message", (event) => {
    writeTerminalEvent(event.data).catch((error) => console.warn("terminal write failed", error));
  });
  socket.addEventListener("close", () => {
    if (state.terminalSocket === socket) {
      state.terminalSocket = null;
      state.terminalConnected = false;
      state.terminalConnecting = false;
      renderOrchestratorLaunch();
    }
  });
  socket.addEventListener("error", () => {
    state.terminalConnecting = false;
    renderOrchestratorLaunch();
  });
}

function disconnectOrchestratorTerminal() {
  const socket = state.terminalSocket;
  if (socket && socket.readyState < WebSocket.CLOSING) {
    socket.close();
  }
  state.terminalSocket = null;
  state.terminalConnected = false;
  state.terminalConnecting = false;
}

function setOrchestratorMode(mode) {
  if (!["structured", "terminal"].includes(mode)) {
    return;
  }
  if (mode === "structured") {
    disconnectOrchestratorTerminal();
  }
  state.orchestratorMode = mode;
  localStorage.setItem(ORCHESTRATOR_MODE_KEY, mode);
  renderOrchestratorLaunch();
  if (mode === "terminal") {
    initOrchestratorTerminal();
    requestAnimationFrame(() => {
      fitOrchestratorTerminal();
      connectOrchestratorTerminal();
      state.terminal?.focus();
    });
  }
}

function orchestratorStatusText(hasWorkspace, serviceRunning) {
  if (!hasWorkspace) {
    return "未选择工作区";
  }
  if (!serviceRunning) {
    return "服务未启动";
  }
  if (state.orchestratorEnsuring) {
    return "正在加载编排者";
  }
  if (state.orchestrator?.running) {
    return state.terminalConnecting ? "编排者运行中，终端连接中" : "编排者运行中";
  }
  if (state.orchestrator?.error) {
    return `错误：${state.orchestrator.error}`;
  }
  return "等待编排者";
}

function renderStructuredOrchestrator() {
  if (!els.orchestratorStructuredLog) {
    return;
  }
  const text = structuredOrchestratorText(state.orchestrator?.text || "");
  els.orchestratorStructuredLog.textContent = text.trim() ? text : "编排者启动后会在这里显示交互输出。";
  els.orchestratorStructuredLog.scrollTop = els.orchestratorStructuredLog.scrollHeight;
  const canSend = Boolean(state.status?.running && currentWorkspace() && state.orchestrator?.running);
  els.orchestratorInput.disabled = state.busy || state.orchestratorEnsuring || state.orchestratorSending || !canSend;
  els.orchestratorSend.disabled = state.busy || state.orchestratorEnsuring || state.orchestratorSending || !canSend;
  setButtonLabel(els.orchestratorSend, state.orchestratorSending ? "发送中" : "发送");
}

function structuredOrchestratorText(text) {
  return stripAnsi(text)
    .split(/\r?\n/)
    .filter((line) => !line.startsWith("[system]"))
    .join("\n")
    .trim();
}

function stripAnsi(text) {
  return String(text || "")
    .replace(/\x1B\][^\x07]*(?:\x07|\x1B\\)/g, "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1B[@-Z\\-_]/g, "")
    .replace(/\r/g, "\n")
    .replace(/[^\S\n]+$/gm, "");
}

function renderOrchestratorLaunch() {
  const workspace = currentWorkspace();
  const hasWorkspace = Boolean(workspace);
  const serviceRunning = Boolean(state.status?.running);
  const terminalMode = state.orchestratorMode === "terminal";
  const statusText = orchestratorStatusText(hasWorkspace, serviceRunning);
  els.orchestratorStatus.textContent = statusText;
  els.orchestratorStatus.className = !hasWorkspace
    ? "stopped"
    : state.orchestrator?.running
      ? "running"
      : state.orchestratorEnsuring
        ? "readonly"
        : "stopped";
  els.orchestratorModeStructured.classList.toggle("active", !terminalMode);
  els.orchestratorModeTerminal.classList.toggle("active", terminalMode);
  els.orchestratorStructured.classList.toggle("hidden", terminalMode);
  els.orchestratorTerminalWrap.classList.toggle("hidden", !terminalMode);
  els.orchestratorRenew.disabled = state.busy || !hasWorkspace || !serviceRunning || state.orchestratorEnsuring;
  if (els.orchestratorWorkspace) {
    els.orchestratorWorkspace.textContent = hasWorkspace ? `${workspace} · ${sessionId()}` : "选择工作区";
  }
  renderStructuredOrchestrator();
  if (terminalMode) {
    initOrchestratorTerminal();
    requestAnimationFrame(() => {
      fitOrchestratorTerminal();
      connectOrchestratorTerminal();
    });
  }
}

async function ensureOrchestrator(options = {}) {
  if (!state.status?.running || !currentWorkspace() || state.orchestratorEnsuring) {
    return state.orchestrator;
  }
  state.orchestratorEnsuring = true;
  renderOrchestratorLaunch();
  try {
    const data = await serviceApi("/api/orchestrator/start", {
      method: "POST",
      body: {
        force: Boolean(options.force),
        command: currentOrchestratorCommand() || undefined,
        ...terminalSizePayload(),
      },
    });
    state.orchestrator = data;
    if (state.orchestratorMode === "terminal") {
      connectOrchestratorTerminal();
    }
    return data;
  } catch (error) {
    state.orchestrator = {
      running: false,
      error: error?.message || String(error),
      text: `错误：${error?.message || error}`,
      lines: [],
    };
    return state.orchestrator;
  } finally {
    state.orchestratorEnsuring = false;
    renderOrchestratorLaunch();
  }
}

async function refreshOrchestratorStatus() {
  if (!state.status?.running || !currentWorkspace()) {
    state.orchestrator = null;
    renderOrchestratorLaunch();
    return null;
  }
  try {
    state.orchestrator = await serviceApi("/api/orchestrator/status");
  } catch (error) {
    state.orchestrator = {
      running: false,
      error: error?.message || String(error),
      text: `错误：${error?.message || error}`,
      lines: [],
    };
  }
  renderOrchestratorLaunch();
  return state.orchestrator;
}

async function refreshOrStartOrchestrator() {
  if (!state.status?.running || !currentWorkspace()) {
    state.orchestrator = null;
    renderOrchestratorLaunch();
    return;
  }
  const key = `${currentWorkspace()}\n${sessionId()}`;
  const status = await refreshOrchestratorStatus();
  if (!status?.running && !status?.error && state.orchestratorAutoStartedFor !== key) {
    state.orchestratorAutoStartedFor = key;
    await ensureOrchestrator();
  }
}

async function sendStructuredCommand() {
  const message = els.orchestratorInput.value.trim();
  if (!message || state.orchestratorSending) {
    return;
  }
  state.orchestratorSending = true;
  renderOrchestratorLaunch();
  try {
    await refreshOrStartOrchestrator();
    state.orchestrator = await serviceApi("/api/orchestrator/send", {
      method: "POST",
      body: { message },
    });
    els.orchestratorInput.value = "";
    window.setTimeout(() => {
      refreshOrchestratorStatus().catch((error) => console.warn("orchestrator refresh failed", error));
    }, 900);
  } catch (error) {
    state.orchestrator = {
      running: false,
      error: error?.message || String(error),
      text: `错误：${error?.message || error}`,
      lines: [],
    };
  } finally {
    state.orchestratorSending = false;
    renderOrchestratorLaunch();
  }
}

function renderSnapshot(snapshot) {
  state.snapshot = snapshot;
  renderDag(snapshot);
  renderTasks(snapshot);
  renderBlocker(snapshot);
  renderRuns(snapshot);
  renderEvents(snapshot);
}

function renderEmptyDag(message) {
  els.dagName.textContent = "未连接";
  els.nodeCount.textContent = "0";
  els.dagSelection.textContent = "未选择";
  els.dagGraph.innerHTML = `<div class="empty">${escapeHtml(message)}</div>`;
  els.nodeDetail.innerHTML = '<div class="empty">暂无节点。</div>';
  els.nodeList.innerHTML = "";
  els.taskSummary.textContent = "0 / 0";
  els.taskList.innerHTML = '<div class="empty">暂无任务。</div>';
  els.blocker.classList.add("hidden");
  els.runs.innerHTML = '<div class="empty">暂无运行记录。</div>';
  els.events.innerHTML = '<div class="empty">暂无事件。</div>';
  renderOrchestratorLaunch();
  state.graphLayout = null;
  state.graphSelectionRect = null;
  setSelectedNodes([]);
  updateDagToolbar();
}

async function refresh() {
  const workspace = currentWorkspace();
  try {
    state.status = await invoke("status");
    state.logs = await invoke("logs");
    if (state.status?.running) {
      state.serviceStartFailed = false;
    }
  } catch (error) {
    state.status = { running: false };
    state.logs = [`error: ${error}`];
    renderShell();
    renderLogs(state.logs);
    renderEmptyDag("无法读取当前工作区状态。");
    return;
  }
  renderShell();
  renderLogs(state.logs);
  if (state.status?.running && workspace) {
    try {
      const payload = await serviceApi("/api/state");
      renderSnapshot(payload);
    } catch (error) {
      renderEmptyDag(`服务已启动，但读取 DAG 状态失败：${error.message}`);
    }
    await ensureOrchestrator();
  } else if (state.status?.running) {
    state.orchestrator = null;
    renderEmptyDag("全局服务已启动。选择工作区和会话后查看 DAG。");
  } else {
    state.orchestrator = null;
    renderEmptyDag("服务未启动。");
  }
}

async function action(fn) {
  setBusy(true);
  try {
    await fn();
    await refresh();
  } catch (error) {
    const message = error?.message || String(error);
    els.currentPath.classList.add("error");
    els.currentPath.textContent = `错误：${message}`;
    renderLogs([`error: ${message}`]);
  } finally {
    setBusy(false);
  }
}

async function restartAppUi() {
  if (isTauriRuntime) {
    try {
      await invoke("restart_ui");
      return;
    } catch (error) {
      console.warn("Tauri app restart failed, falling back to location reload", error);
    }
  }
  window.location.reload();
}

async function runServiceAction(actionName, body) {
  const data = await serviceApi(`/api/${actionName}`, {
    method: "POST",
    body,
  });
  renderSnapshot(data.snapshot || data);
}

async function chooseWorkspace(command) {
  setProjectMenu(false);
  if (!isTauriRuntime) {
    throw new Error("浏览器模式不能打开系统目录选择器，请通过 URL 的 cwd 参数指定工作区。");
  }
  const path = await invoke(command);
  if (path) {
    addWorkspacePath(path);
    await refresh();
  }
}

function droppedPathsFromPayload(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (Array.isArray(payload?.paths)) {
    return payload.paths;
  }
  if (typeof payload === "string") {
    return [payload];
  }
  return [];
}

function droppedPathsFromDataTransfer(dataTransfer) {
  const paths = [];
  for (const file of Array.from(dataTransfer?.files || [])) {
    const path = file.path || file.webkitRelativePath || file.name;
    if (path) {
      paths.push(path);
    }
  }
  const uriList = dataTransfer?.getData?.("text/uri-list") || "";
  for (const line of uriList.split(/\r?\n/)) {
    if (line && !line.startsWith("#")) {
      paths.push(line);
    }
  }
  return paths;
}

async function addDroppedPaths(paths) {
  const firstPath = paths.map(normalizeDroppedPath).find(Boolean);
  if (!firstPath) {
    els.currentPath.classList.add("error");
    els.currentPath.textContent = "无法从拖入内容读取目录路径。";
    return;
  }
  addWorkspacePath(firstPath);
  await refresh();
}

function setDropActive(active) {
  els.projectPanel.classList.toggle("drop-active", active);
  els.dropHint.classList.toggle("hidden", !active);
}

function rerenderGraphIfNeeded() {
  if (state.snapshot) {
    renderDag(state.snapshot);
  }
}

function setupResizeHandle(handle, type) {
  if (!handle) {
    return;
  }
  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    handle.classList.add("dragging");
    const start = {
      x: event.clientX,
      y: event.clientY,
      layout: { ...state.layout },
    };
    const move = (moveEvent) => {
      if (type === "sidebar") {
        state.layout.sidebarWidth = clamp(moveEvent.clientX, 180, 520);
      } else if (type === "inspector") {
        const rect = document.querySelector("#console-view").getBoundingClientRect();
        state.layout.inspectorWidth = clamp(rect.right - moveEvent.clientX, 240, Math.max(260, rect.width - 320));
      } else if (type === "task") {
        const rect = document.querySelector("#console-view").getBoundingClientRect();
        state.layout.taskHeight = clamp(rect.bottom - moveEvent.clientY, 120, Math.max(140, rect.height - 220));
      } else if (type === "bottom") {
        const rect = els.mainShell.getBoundingClientRect();
        state.layout.bottomHeight = clamp(rect.bottom - moveEvent.clientY, 150, Math.max(180, rect.height - 180));
      }
      applyLayout();
      rerenderGraphIfNeeded();
      fitOrchestratorTerminal();
    };
    const up = () => {
      handle.classList.remove("dragging");
      saveLayout();
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}

function handleGraphPointerDown(event) {
  if (!state.graphLayout || !state.snapshot) {
    return;
  }
  const nodeTarget = event.target.closest?.(".graph-node");
  const point = graphPointFromEvent(event);
  const shouldSelect = state.graphSelectMode || event.shiftKey;
  if (nodeTarget && !state.graphSelectMode) {
    const id = nodeTarget.dataset.nodeId;
    if (event.shiftKey || event.metaKey) {
      const next = new Set(state.selectedNodeIds);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      setSelectedNodes([...next], id);
    } else {
      setSelectedNodes([id], id);
    }
    renderDag(state.snapshot);
    event.preventDefault();
    return;
  }

  event.preventDefault();
  els.dagGraph.setPointerCapture(event.pointerId);
  state.graphDrag = {
    pointerId: event.pointerId,
    mode: shouldSelect ? "select" : "pan",
    start: point,
    last: point,
    moved: false,
    startNodeId: nodeTarget?.dataset?.nodeId || null,
  };
  els.dagGraph.classList.toggle("selecting", shouldSelect);
  els.dagGraph.classList.toggle("panning", !shouldSelect);
  if (shouldSelect) {
    state.graphSelectionRect = { x: point.x, y: point.y, width: 0, height: 0 };
    renderDag(state.snapshot);
  }
}

function handleGraphPointerMove(event) {
  const drag = state.graphDrag;
  if (!drag || drag.pointerId !== event.pointerId) {
    return;
  }
  const point = graphPointFromEvent(event);
  const dx = point.x - drag.last.x;
  const dy = point.y - drag.last.y;
  drag.moved = drag.moved || Math.abs(point.x - drag.start.x) > 3 || Math.abs(point.y - drag.start.y) > 3;
  drag.last = point;
  if (drag.mode === "pan") {
    state.graphView.x += dx;
    state.graphView.y += dy;
    updateGraphTransform();
    return;
  }
  state.graphSelectionRect = normalizeRect(drag.start, point);
  renderDag(state.snapshot);
}

function handleGraphPointerUp(event) {
  const drag = state.graphDrag;
  if (!drag || drag.pointerId !== event.pointerId) {
    return;
  }
  if (drag.mode === "select" && state.graphSelectionRect) {
    const ids = drag.moved
      ? selectedNodeIdsInRect(state.graphSelectionRect)
      : (drag.startNodeId ? [drag.startNodeId] : []);
    setSelectedNodes(ids);
  }
  state.graphDrag = null;
  state.graphSelectionRect = null;
  els.dagGraph.classList.remove("panning", "selecting");
  saveGraphView();
  if (state.snapshot) {
    renderDag(state.snapshot);
  }
}

function setupGraphInteractions() {
  els.dagGraph.addEventListener("pointerdown", handleGraphPointerDown);
  els.dagGraph.addEventListener("pointermove", handleGraphPointerMove);
  els.dagGraph.addEventListener("pointerup", handleGraphPointerUp);
  els.dagGraph.addEventListener("pointercancel", handleGraphPointerUp);
  els.dagGraph.addEventListener("wheel", (event) => {
    if (!state.graphLayout) {
      return;
    }
    event.preventDefault();
    const factor = event.deltaY > 0 ? 0.9 : 1.1;
    zoomGraphAt(state.graphView.scale * factor, graphPointFromEvent(event));
  }, { passive: false });
}

els.start.addEventListener("click", () => action(async () => {
  if (state.status?.running) {
    state.serviceStartFailed = false;
    await invoke("stop_service");
    return;
  }
  const workspace = currentWorkspace();
  if (workspace) {
    addWorkspace();
  }
  try {
    await invoke("start_service", {
      request: {
        cwd: workspace || null,
        port: Number(els.port.value || 7331),
        orchestrator_command: currentOrchestratorCommand() || null,
      },
    });
    state.serviceStartFailed = false;
  } catch (error) {
    state.serviceStartFailed = true;
    throw error;
  }
}));

els.forceStop.addEventListener("click", () => action(async () => {
  await invoke("force_stop_service");
  state.serviceStartFailed = false;
}));

els.openBrowser.addEventListener("click", () => action(async () => {
  const workspace = currentWorkspace();
  if (workspace) {
    await invoke("open_dashboard_for_workspace", { cwd: workspace, sessionId: sessionId() });
  } else {
    await invoke("open_dashboard");
  }
}));

els.refresh.addEventListener("click", () => action(refresh));
els.restartApp.addEventListener("click", () => {
  restartAppUi();
});
els.zoomOut.addEventListener("click", () => zoomGraphAt(state.graphView.scale * 0.85));
els.zoomIn.addEventListener("click", () => zoomGraphAt(state.graphView.scale * 1.15));
els.zoomReset.addEventListener("click", resetGraphView);
els.selectMode.addEventListener("click", () => {
  state.graphSelectMode = !state.graphSelectMode;
  updateDagToolbar();
});
els.copyNode.addEventListener("click", () => {
  copySelectedNodeInfo().catch((error) => {
    els.currentPath.classList.add("error");
    els.currentPath.textContent = `复制失败：${error?.message || error}`;
  });
});
els.projectMenuToggle.addEventListener("click", (event) => {
  event.stopPropagation();
  setProjectMenu(els.projectMenu.classList.contains("hidden"));
});
els.createProject.addEventListener("click", () => action(() => chooseWorkspace("choose_empty_project_folder")));
els.useFolder.addEventListener("click", () => action(() => chooseWorkspace("choose_existing_folder")));
els.removeWorkspace.addEventListener("click", removeWorkspace);
els.openServerSettings.addEventListener("click", () => setMainView("settings"));
els.closeServerSettings.addEventListener("click", () => setMainView("console"));
els.orchestratorCommand.addEventListener("input", saveOrchestratorCommand);
els.clearLogs.addEventListener("click", () => action(async () => {
  await invoke("clear_logs");
}));
els.orchestratorModeStructured.addEventListener("click", () => setOrchestratorMode("structured"));
els.orchestratorModeTerminal.addEventListener("click", () => setOrchestratorMode("terminal"));
els.orchestratorRenew.addEventListener("click", () => action(async () => {
  disconnectOrchestratorTerminal();
  await ensureOrchestrator({ force: true });
  if (state.orchestratorMode === "terminal") {
    connectOrchestratorTerminal();
  }
}));
els.orchestratorSend.addEventListener("click", () => sendStructuredCommand());
els.orchestratorInput.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    sendStructuredCommand();
  }
});

els.projectPanel.addEventListener("dragover", (event) => {
  event.preventDefault();
  setDropActive(true);
});
els.projectPanel.addEventListener("dragleave", (event) => {
  if (!els.projectPanel.contains(event.relatedTarget)) {
    setDropActive(false);
  }
});
els.projectPanel.addEventListener("drop", (event) => {
  event.preventDefault();
  setDropActive(false);
  action(() => addDroppedPaths(droppedPathsFromDataTransfer(event.dataTransfer)));
});

document.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) {
    return;
  }
  if (!target.closest("#project-menu") && !target.closest("#project-menu-toggle")) {
    setProjectMenu(false);
  }

  const tab = target.closest("[data-tab]");
  if (tab) {
    document.querySelectorAll(".tab").forEach((item) => item.classList.toggle("active", item === tab));
    document.querySelectorAll(".tab-panel").forEach((panel) => panel.classList.toggle("active", panel.id === `tab-${tab.dataset.tab}`));
    requestAnimationFrame(fitOrchestratorTerminal);
    return;
  }

  const newSessionTarget = target.closest("[data-new-session]");
  if (newSessionTarget) {
    addSession(newSessionTarget.dataset.newSession);
    action(refresh);
    return;
  }

  const sessionTarget = target.closest("[data-session-id]");
  if (sessionTarget) {
    selectWorkspace(sessionTarget.dataset.workspace);
    selectSession(sessionTarget.dataset.sessionId);
    action(refresh);
    return;
  }

  const workspaceTarget = target.closest("[data-workspace]");
  if (workspaceTarget) {
    selectWorkspace(workspaceTarget.dataset.workspace);
    action(refresh);
    return;
  }

  const nodeTarget = target.closest("[data-node-id]");
  if (nodeTarget) {
    if (nodeTarget.closest(".graph-node")) {
      return;
    }
    const id = nodeTarget.dataset.nodeId;
    if (event.shiftKey || event.metaKey) {
      const next = new Set(state.selectedNodeIds);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      setSelectedNodes([...next], id);
    } else {
      setSelectedNodes([id], id);
    }
    if (state.snapshot) {
      renderSnapshot(state.snapshot);
    }
    return;
  }

  const serviceAction = target.closest("[data-service-action]");
  if (serviceAction) {
    action(async () => {
      await runServiceAction(serviceAction.dataset.serviceAction, serviceAction.dataset.serviceAction === "run-until-blocked" ? { limit: 50 } : undefined);
    });
    return;
  }

  const blockerAction = target.closest("[data-blocker-id]");
  if (blockerAction) {
    action(async () => {
      const type = blockerAction.dataset.blockerType;
      if (type === "review") {
        await runServiceAction("approve", { id: blockerAction.dataset.blockerId });
      } else {
        await runServiceAction("resolve", {
          id: blockerAction.dataset.blockerId,
          answer: blockerAction.dataset.answer || "",
        });
      }
    });
  }
});

if (!isTauriRuntime && !state.selectedWorkspace && state.workspaces.length === 0 && INITIAL_CWD) {
  state.workspaces = [INITIAL_CWD];
  state.selectedWorkspace = INITIAL_CWD;
  sessionsFor(INITIAL_CWD);
  saveWorkspaces();
  saveSessions();
}

if (state.selectedWorkspace) {
  els.cwd.value = state.selectedWorkspace;
  const sessions = sessionsFor(state.selectedWorkspace);
  if (!sessions.some((item) => item.id === state.selectedSessionId)) {
    state.selectedSessionId = sessions[0]?.id || "default";
    saveSessions();
  }
} else if (state.workspaces[0]) {
  selectWorkspace(state.workspaces[0]);
}

applyLayout();
setupResizeHandle(els.sidebarResizer, "sidebar");
setupResizeHandle(els.inspectorResizer, "inspector");
setupResizeHandle(els.taskResizer, "task");
setupResizeHandle(els.bottomResizer, "bottom");
setupGraphInteractions();
window.addEventListener("resize", () => {
  rerenderGraphIfNeeded();
  fitOrchestratorTerminal();
});

renderShell();
refresh();
setInterval(() => {
  if (!state.busy && document.visibilityState !== "hidden") {
    refresh();
  }
}, REFRESH_INTERVAL_MS);

async function setupNativeDrop() {
  const eventApi = window.__TAURI__?.event;
  if (!eventApi?.listen) {
    return;
  }
  const handler = (event) => {
    action(() => addDroppedPaths(droppedPathsFromPayload(event.payload)));
  };
  try {
    await eventApi.listen("tauri://drag-drop", handler);
    await eventApi.listen("tauri://file-drop", handler);
  } catch (error) {
    console.warn("native drop listener unavailable", error);
  }
}

setupNativeDrop();

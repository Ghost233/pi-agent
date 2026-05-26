use portable_pty::PtySize;
use serde_json::{json, Map, Value};
use std::{
    collections::HashMap,
    ffi::CString,
    env, fs,
    fs::File,
    io::{Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{mpsc, Mutex, OnceLock},
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::{fd::{AsRawFd, FromRawFd}, unix::ffi::OsStrExt};

const FLOW_DIR: &str = ".pi-flow";
const SESSIONS_DIR: &str = "sessions";
const DAG_FILE: &str = "dag.json";
const TASKS_FILE: &str = "tasks.ndjson";
const STATE_FILE: &str = "state.json";
const ORCHESTRATOR_DIR: &str = "orchestrator";
const ORCHESTRATOR_RECORD_FILE: &str = "session.json";
const ORCHESTRATOR_LOG_FILE: &str = "session.log";

const CLOSED_TASK_STATUSES: &[&str] = &["done", "failed", "skipped"];
const STOP_TASK_STATUSES: &[&str] = &["blocked", "waiting_review"];

#[derive(Clone)]
struct FlowPaths {
    root: PathBuf,
    session_id: String,
    flow_dir: PathBuf,
    dag: PathBuf,
    tasks: PathBuf,
    state: PathBuf,
    runs: PathBuf,
}

struct LoadedFlow {
    paths: FlowPaths,
    dag: Value,
    tasks: Vec<Value>,
    state: Value,
}

struct Request {
    method: String,
    path: String,
    query: HashMap<String, String>,
    headers: HashMap<String, String>,
    body: Vec<u8>,
}

struct OrchestratorProcess {
    pid: u32,
    cwd: String,
    session_id: String,
    command: String,
    args: Vec<String>,
    log_path: PathBuf,
    started_at: String,
    writer: Box<dyn Write + Send>,
    clients: std::sync::Arc<Mutex<Vec<(String, mpsc::Sender<Vec<u8>>)>>>,
    #[cfg(unix)]
    resize_handle: Option<File>,
    size: PtySize,
}

static ORCHESTRATORS: OnceLock<Mutex<HashMap<String, OrchestratorProcess>>> = OnceLock::new();

fn now() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("unix:{seconds}")
}

fn safe_run_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    format!("{millis}-{:x}", std::process::id())
}

fn safe_segment(value: &str) -> String {
    let segment: String = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-' | '.') {
                ch
            } else {
                '_'
            }
        })
        .take(96)
        .collect();
    if segment.is_empty() {
        "default".to_string()
    } else {
        segment
    }
}

fn flow_paths(cwd: &str, session_id: &str) -> FlowPaths {
    let root = PathBuf::from(cwd).canonicalize().unwrap_or_else(|_| PathBuf::from(cwd));
    let session_id = safe_segment(session_id);
    let flow_dir = if session_id == "default" {
        root.join(FLOW_DIR)
    } else {
        root.join(FLOW_DIR).join(SESSIONS_DIR).join(&session_id)
    };
    FlowPaths {
        root: root.clone(),
        session_id,
        dag: flow_dir.join(DAG_FILE),
        tasks: flow_dir.join(TASKS_FILE),
        state: flow_dir.join(STATE_FILE),
        runs: flow_dir.join("runs"),
        flow_dir,
    }
}

fn object_mut(value: &mut Value) -> &mut Map<String, Value> {
    if !value.is_object() {
        *value = json!({});
    }
    value.as_object_mut().expect("object")
}

fn array_mut(value: &mut Value) -> &mut Vec<Value> {
    if !value.is_array() {
        *value = json!([]);
    }
    value.as_array_mut().expect("array")
}

fn set_field(value: &mut Value, key: &str, field: Value) {
    object_mut(value).insert(key.to_string(), field);
}

fn remove_field(value: &mut Value, key: &str) {
    if let Some(object) = value.as_object_mut() {
        object.remove(key);
    }
}

fn field_str(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(ToString::to_string)
}

fn field_bool(value: &Value, key: &str) -> bool {
    value.get(key).and_then(Value::as_bool).unwrap_or(false)
}

fn read_json(file_path: &Path, default_value: Value) -> Result<Value, String> {
    if !file_path.exists() {
        return Ok(default_value);
    }
    let raw = fs::read_to_string(file_path)
        .map_err(|error| format!("无法读取 JSON {}: {error}", file_path.display()))?;
    if raw.trim().is_empty() {
        return Ok(default_value);
    }
    serde_json::from_str(&raw)
        .map_err(|error| format!("无法解析 JSON {}: {error}", file_path.display()))
}

fn write_json_atomic(file_path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建目录 {}: {error}", parent.display()))?;
    }
    let temp_path = file_path.with_extension(format!("tmp-{}", std::process::id()));
    let body = serde_json::to_string_pretty(value)
        .map_err(|error| format!("无法序列化 JSON {}: {error}", file_path.display()))?;
    fs::write(&temp_path, format!("{body}\n"))
        .map_err(|error| format!("无法写入临时文件 {}: {error}", temp_path.display()))?;
    fs::rename(&temp_path, file_path)
        .map_err(|error| format!("无法替换文件 {}: {error}", file_path.display()))
}

fn write_text_atomic(file_path: &Path, value: &str) -> Result<(), String> {
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建目录 {}: {error}", parent.display()))?;
    }
    let temp_path = file_path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&temp_path, value)
        .map_err(|error| format!("无法写入临时文件 {}: {error}", temp_path.display()))?;
    fs::rename(&temp_path, file_path)
        .map_err(|error| format!("无法替换文件 {}: {error}", file_path.display()))
}

fn append_text(file_path: &Path, value: &str) -> Result<(), String> {
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建目录 {}: {error}", parent.display()))?;
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file_path)
        .map_err(|error| format!("无法打开日志 {}: {error}", file_path.display()))?;
    file.write_all(value.as_bytes())
        .map_err(|error| format!("无法写入日志 {}: {error}", file_path.display()))
}

fn truncate_file(file_path: &Path) -> Result<(), String> {
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建目录 {}: {error}", parent.display()))?;
    }
    fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(file_path)
        .map(|_| ())
        .map_err(|error| format!("无法清空文件 {}: {error}", file_path.display()))
}

fn read_tasks(file_path: &Path) -> Result<Vec<Value>, String> {
    if !file_path.exists() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(file_path)
        .map_err(|error| format!("无法读取任务文件 {}: {error}", file_path.display()))?;
    raw.lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(|line| serde_json::from_str(line).map_err(|error| format!("无法解析任务行: {error}")))
        .collect()
}

fn write_tasks(file_path: &Path, tasks: &[Value]) -> Result<(), String> {
    let mut body = String::new();
    for task in tasks {
        body.push_str(
            &serde_json::to_string(task).map_err(|error| format!("无法序列化任务: {error}"))?,
        );
        body.push('\n');
    }
    write_text_atomic(file_path, &body)
}

fn normalize_dag(dag: Value) -> Value {
    if dag.is_array() {
        return json!({
            "version": 1,
            "name": "DAG",
            "nodes": dag,
        });
    }
    let mut dag = if dag.is_object() { dag } else { json!({}) };
    let object = object_mut(&mut dag);
    object.entry("version").or_insert(json!(1));
    object.entry("name").or_insert(json!("DAG"));
    object.entry("created_at").or_insert(Value::Null);
    object.entry("updated_at").or_insert(Value::Null);
    if !object.get("nodes").is_some_and(Value::is_array) {
        object.insert("nodes".to_string(), json!([]));
    }
    dag
}

fn empty_state() -> Value {
    json!({
        "version": 1,
        "dag": {
            "completed": [],
            "failed": [],
            "blocked": [],
            "waiting_review": [],
            "current": null
        },
        "tasks": {
            "current": null
        },
        "events": [],
        "updated_at": now()
    })
}

fn normalize_state(state: Value) -> Value {
    let mut output = empty_state();
    let input = state.as_object();
    if let Some(version) = input.and_then(|object| object.get("version")) {
        set_field(&mut output, "version", version.clone());
    }
    for key in ["completed", "failed", "blocked", "waiting_review"] {
        if let Some(value) = input
            .and_then(|object| object.get("dag"))
            .and_then(|dag| dag.get(key))
            .filter(|value| value.is_array())
        {
            state_dag_mut(&mut output).insert(key.to_string(), value.clone());
        }
    }
    if let Some(value) = input
        .and_then(|object| object.get("dag"))
        .and_then(|dag| dag.get("current"))
    {
        state_dag_mut(&mut output).insert("current".to_string(), value.clone());
    }
    if let Some(value) = input
        .and_then(|object| object.get("tasks"))
        .and_then(|tasks| tasks.get("current"))
    {
        state_tasks_mut(&mut output).insert("current".to_string(), value.clone());
    }
    if let Some(events) = input
        .and_then(|object| object.get("events"))
        .and_then(Value::as_array)
    {
        let tail = events
            .iter()
            .skip(events.len().saturating_sub(200))
            .cloned()
            .collect::<Vec<_>>();
        object_mut(&mut output).insert("events".to_string(), Value::Array(tail));
    }
    if let Some(value) = input.and_then(|object| object.get("updated_at")) {
        set_field(&mut output, "updated_at", value.clone());
    }
    output
}

fn state_dag_mut(state: &mut Value) -> &mut Map<String, Value> {
    let root = object_mut(state);
    let value = root.entry("dag").or_insert_with(|| json!({}));
    object_mut(value)
}

fn state_tasks_mut(state: &mut Value) -> &mut Map<String, Value> {
    let root = object_mut(state);
    let value = root.entry("tasks").or_insert_with(|| json!({}));
    object_mut(value)
}

fn state_array_mut<'a>(state: &'a mut Value, key: &str) -> &'a mut Vec<Value> {
    let dag = state_dag_mut(state);
    let value = dag.entry(key.to_string()).or_insert_with(|| json!([]));
    array_mut(value)
}

fn state_array_contains(state: &Value, key: &str, id: &str) -> bool {
    state
        .get("dag")
        .and_then(|dag| dag.get(key))
        .and_then(Value::as_array)
        .is_some_and(|items| items.iter().any(|item| item.as_str() == Some(id)))
}

fn unique_push_state(state: &mut Value, key: &str, id: &str) {
    if !state_array_contains(state, key, id) {
        state_array_mut(state, key).push(json!(id));
    }
}

fn remove_id_state(state: &mut Value, key: &str, id: &str) {
    let items = state_array_mut(state, key);
    items.retain(|item| item.as_str() != Some(id));
}

fn dag_nodes(dag: &Value) -> Vec<Value> {
    dag.get("nodes")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

fn dag_nodes_mut(dag: &mut Value) -> &mut Vec<Value> {
    let object = object_mut(dag);
    let value = object.entry("nodes").or_insert_with(|| json!([]));
    array_mut(value)
}

fn node_index_by_id(nodes: &[Value], id: &str) -> Option<usize> {
    nodes.iter().position(|node| field_str(node, "id").as_deref() == Some(id))
}

fn task_index_by_id(tasks: &[Value], id: &str) -> Option<usize> {
    tasks.iter().position(|task| field_str(task, "id").as_deref() == Some(id))
}

fn node_status(node: &Value, state: &Value) -> String {
    let id = field_str(node, "id").unwrap_or_default();
    if state_array_contains(state, "completed", &id) || field_str(node, "status").as_deref() == Some("done") {
        return "done".to_string();
    }
    if state_array_contains(state, "failed", &id) || field_str(node, "status").as_deref() == Some("failed") {
        return "failed".to_string();
    }
    if state_array_contains(state, "blocked", &id) || field_str(node, "status").as_deref() == Some("blocked") {
        return "blocked".to_string();
    }
    if state_array_contains(state, "waiting_review", &id)
        || field_str(node, "status").as_deref() == Some("waiting_review")
    {
        return "waiting_review".to_string();
    }
    if state
        .get("dag")
        .and_then(|dag| dag.get("current"))
        .and_then(Value::as_str)
        == Some(id.as_str())
        || field_str(node, "status").as_deref() == Some("running")
    {
        return "running".to_string();
    }
    field_str(node, "status").unwrap_or_else(|| "pending".to_string())
}

fn deps_done(node: &Value, dag: &Value, state: &Value) -> bool {
    let deps = node
        .get("depends_on")
        .or_else(|| node.get("dependsOn"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let nodes = dag_nodes(dag);
    deps.iter().all(|dep| {
        let Some(dep_id) = dep.as_str() else {
            return false;
        };
        nodes
            .iter()
            .find(|candidate| field_str(candidate, "id").as_deref() == Some(dep_id))
            .is_some_and(|dep_node| node_status(dep_node, state) == "done")
    })
}

fn mark_node_done(dag: &mut Value, state: &mut Value, id: &str) {
    if let Some(index) = node_index_by_id(dag_nodes_mut(dag), id) {
        set_field(&mut dag_nodes_mut(dag)[index], "status", json!("done"));
    }
    state_dag_mut(state).insert("current".to_string(), Value::Null);
    remove_id_state(state, "blocked", id);
    remove_id_state(state, "waiting_review", id);
    unique_push_state(state, "completed", id);
}

fn mark_node_waiting_review(dag: &mut Value, state: &mut Value, id: &str) {
    if let Some(index) = node_index_by_id(dag_nodes_mut(dag), id) {
        set_field(&mut dag_nodes_mut(dag)[index], "status", json!("waiting_review"));
    }
    state_dag_mut(state).insert("current".to_string(), Value::Null);
    unique_push_state(state, "waiting_review", id);
}

fn mark_node_running(dag: &mut Value, state: &mut Value, id: &str) {
    if let Some(index) = node_index_by_id(dag_nodes_mut(dag), id) {
        set_field(&mut dag_nodes_mut(dag)[index], "status", json!("running"));
    }
    state_dag_mut(state).insert("current".to_string(), json!(id));
}

fn record_event(state: &mut Value, event_type: &str, payload: Value) {
    let root = object_mut(state);
    let events = array_mut(root.entry("events").or_insert_with(|| json!([])));
    events.push(json!({
        "type": event_type,
        "payload": payload,
        "at": now()
    }));
    if events.len() > 200 {
        let remove_count = events.len() - 200;
        events.drain(0..remove_count);
    }
    root.insert("updated_at".to_string(), json!(now()));
}

fn load(cwd: &str, session_id: &str) -> Result<LoadedFlow, String> {
    let paths = flow_paths(cwd, session_id);
    Ok(LoadedFlow {
        dag: normalize_dag(read_json(&paths.dag, Value::Null)?),
        tasks: read_tasks(&paths.tasks)?,
        state: normalize_state(read_json(&paths.state, Value::Null)?),
        paths,
    })
}

fn save_dag(paths: &FlowPaths, dag: &Value) -> Result<(), String> {
    let mut next_dag = dag.clone();
    set_field(&mut next_dag, "updated_at", json!(now()));
    write_json_atomic(&paths.dag, &next_dag)
}

fn save_state(paths: &FlowPaths, state: &mut Value) -> Result<(), String> {
    set_field(state, "updated_at", json!(now()));
    write_json_atomic(&paths.state, state)
}

fn task_counts(tasks: &[Value]) -> Value {
    let mut counts = Map::from_iter([
        ("total".to_string(), json!(tasks.len())),
        ("pending".to_string(), json!(0)),
        ("ready".to_string(), json!(0)),
        ("running".to_string(), json!(0)),
        ("done".to_string(), json!(0)),
        ("failed".to_string(), json!(0)),
        ("blocked".to_string(), json!(0)),
        ("waiting_review".to_string(), json!(0)),
        ("skipped".to_string(), json!(0)),
    ]);
    for task in tasks {
        let status = field_str(task, "status").unwrap_or_else(|| "pending".to_string());
        let current = counts.get(&status).and_then(Value::as_u64).unwrap_or(0);
        counts.insert(status, json!(current + 1));
    }
    Value::Object(counts)
}

fn count_value(counts: &Value, key: &str) -> u64 {
    counts.get(key).and_then(Value::as_u64).unwrap_or(0)
}

fn write_run(paths: &FlowPaths, entity_id: &str, result: &Value) -> Result<Value, String> {
    let run_id = safe_run_id();
    let run_dir = paths.runs.join(entity_id).join(&run_id);
    fs::create_dir_all(&run_dir)
        .map_err(|error| format!("无法创建运行目录 {}: {error}", run_dir.display()))?;
    write_json_atomic(
        &run_dir.join("metadata.json"),
        &json!({
            "id": run_id,
            "entity_id": entity_id,
            "status": field_str(result, "status").unwrap_or_default(),
            "created_at": now()
        }),
    )?;
    write_json_atomic(&run_dir.join("result.json"), result)?;
    let summary = field_str(result, "summary")
        .or_else(|| field_str(result, "message"))
        .or_else(|| field_str(result, "status"))
        .unwrap_or_default();
    write_text_atomic(&run_dir.join("log.md"), &format!("{summary}\n"))?;
    write_text_atomic(
        &run_dir.join("diff.patch"),
        result.get("diff").and_then(Value::as_str).unwrap_or_default(),
    )?;
    Ok(json!({
        "run_id": run_id,
        "run_dir": run_dir.strip_prefix(&paths.root).unwrap_or(&run_dir).to_string_lossy()
    }))
}

fn latest_runs(paths: &FlowPaths) -> Vec<Value> {
    let Ok(entities) = fs::read_dir(&paths.runs) else {
        return Vec::new();
    };
    let mut rows = Vec::new();
    for entity in entities.flatten() {
        if !entity.file_type().is_ok_and(|file_type| file_type.is_dir()) {
            continue;
        }
        let entity_id = entity.file_name().to_string_lossy().to_string();
        let Ok(run_entries) = fs::read_dir(entity.path()) else {
            continue;
        };
        let mut run_ids = run_entries
            .flatten()
            .filter(|entry| entry.file_type().is_ok_and(|file_type| file_type.is_dir()))
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .collect::<Vec<_>>();
        run_ids.sort();
        let Some(run_id) = run_ids.last() else {
            continue;
        };
        let result = read_json(&entity.path().join(run_id).join("result.json"), json!({}))
            .unwrap_or_else(|_| json!({}));
        rows.push(json!({
            "entity_id": entity_id,
            "run_id": run_id,
            "result": result
        }));
    }
    rows.sort_by(|a, b| {
        field_str(b, "run_id")
            .unwrap_or_default()
            .cmp(&field_str(a, "run_id").unwrap_or_default())
    });
    rows
}

fn get_snapshot(cwd: &str, session_id: &str) -> Result<Value, String> {
    let LoadedFlow {
        paths,
        dag,
        tasks,
        state,
    } = load(cwd, session_id)?;
    let nodes = dag_nodes(&dag)
        .into_iter()
        .map(|mut node| {
            let status = node_status(&node, &state);
            let ready = status == "pending" && deps_done(&node, &dag, &state);
            set_field(&mut node, "status", json!(status));
            set_field(&mut node, "ready", json!(ready));
            node
        })
        .collect::<Vec<_>>();
    let mut snapshot_dag = dag.clone();
    set_field(&mut snapshot_dag, "nodes", Value::Array(nodes));
    Ok(json!({
        "cwd": paths.root,
        "session_id": paths.session_id,
        "flow_dir": paths.flow_dir.strip_prefix(&paths.root).unwrap_or(&paths.flow_dir).to_string_lossy(),
        "exists": paths.dag.exists(),
        "dag": snapshot_dag,
        "task_counts": task_counts(&tasks),
        "tasks": tasks,
        "state": state,
        "runs": latest_runs(&paths)
    }))
}

fn approve_node(cwd: &str, id: &str, session_id: &str) -> Result<Value, String> {
    let LoadedFlow {
        paths,
        mut dag,
        mut state,
        ..
    } = load(cwd, session_id)?;
    if !dag_nodes(&dag).iter().any(|node| field_str(node, "id").as_deref() == Some(id)) {
        return Err(format!("Node not found: {id}"));
    }
    mark_node_done(&mut dag, &mut state, id);
    record_event(&mut state, "node_approved", json!({ "id": id }));
    save_dag(&paths, &dag)?;
    save_state(&paths, &mut state)?;
    get_snapshot(cwd, session_id)
}

fn resolve_task(cwd: &str, id: &str, answer: &str, session_id: &str) -> Result<Value, String> {
    let LoadedFlow {
        paths,
        mut tasks,
        mut state,
        ..
    } = load(cwd, session_id)?;
    let Some(index) = task_index_by_id(&tasks, id) else {
        return Err(format!("Task not found: {id}"));
    };
    let task = &mut tasks[index];
    set_field(task, "status", json!("pending"));
    set_field(
        task,
        "resolution",
        json!({
            "answer": answer,
            "resolved_at": now()
        }),
    );
    remove_field(task, "blocked_at");
    state_tasks_mut(&mut state).insert("current".to_string(), Value::Null);
    record_event(&mut state, "task_resolved", json!({ "id": id, "answer": answer }));
    write_tasks(&paths.tasks, &tasks)?;
    save_state(&paths, &mut state)?;
    get_snapshot(cwd, session_id)
}

fn rerun_task(cwd: &str, id: &str, session_id: &str) -> Result<Value, String> {
    let LoadedFlow {
        paths,
        mut tasks,
        mut state,
        ..
    } = load(cwd, session_id)?;
    let Some(index) = task_index_by_id(&tasks, id) else {
        return Err(format!("Task not found: {id}"));
    };
    let task = &mut tasks[index];
    set_field(task, "status", json!("pending"));
    for key in ["completed_at", "failed_at", "blocked_at", "result"] {
        remove_field(task, key);
    }
    record_event(&mut state, "task_requeued", json!({ "id": id }));
    write_tasks(&paths.tasks, &tasks)?;
    save_state(&paths, &mut state)?;
    get_snapshot(cwd, session_id)
}

fn find_ready_node_index(dag: &Value, state: &Value) -> Option<usize> {
    let nodes = dag_nodes(dag);
    nodes
        .iter()
        .position(|node| node_status(node, state) == "pending" && deps_done(node, dag, state))
}

fn first_open_task_index(tasks: &[Value]) -> Option<usize> {
    tasks.iter().position(|task| {
        let status = field_str(task, "status").unwrap_or_else(|| "pending".to_string());
        !CLOSED_TASK_STATUSES.contains(&status.as_str())
            && !STOP_TASK_STATUSES.contains(&status.as_str())
            && status != "running"
    })
}

fn run_next(cwd: &str, session_id: &str) -> Result<Value, String> {
    let LoadedFlow {
        paths,
        mut dag,
        mut tasks,
        mut state,
    } = load(cwd, session_id)?;
    if !paths.dag.exists() {
        return Ok(json!({
            "status": "NO_DAG",
            "message": "Create a DAG first.",
            "snapshot": get_snapshot(cwd, session_id)?
        }));
    }

    if let Some(waiting_node) = dag_nodes(&dag)
        .into_iter()
        .find(|node| node_status(node, &state) == "waiting_review")
    {
        return Ok(json!({
            "status": "WAITING_REVIEW",
            "node": waiting_node,
            "question": field_str(&waiting_node, "question").unwrap_or_else(|| "Review is required before continuing.".to_string()),
            "snapshot": get_snapshot(cwd, session_id)?
        }));
    }

    if let Some(blocked_task) = tasks
        .iter()
        .find(|task| field_str(task, "status").as_deref() == Some("blocked"))
        .cloned()
    {
        return Ok(json!({
            "status": "TASK_BLOCKED",
            "task": blocked_task,
            "question": field_str(&blocked_task, "question").unwrap_or_else(|| "This task needs a user decision.".to_string()),
            "snapshot": get_snapshot(cwd, session_id)?
        }));
    }

    let nodes = dag_nodes(&dag);
    let mut ready_index = state
        .get("dag")
        .and_then(|dag_state| dag_state.get("current"))
        .and_then(Value::as_str)
        .and_then(|current| node_index_by_id(&nodes, current))
        .filter(|index| {
            field_str(&nodes[*index], "type").as_deref() == Some("map")
                && node_status(&nodes[*index], &state) == "running"
        });
    if ready_index.is_none() {
        ready_index = find_ready_node_index(&dag, &state);
    }
    let Some(ready_index) = ready_index else {
        let all_done = !nodes.is_empty() && nodes.iter().all(|node| node_status(node, &state) == "done");
        return Ok(json!({
            "status": if all_done { "DAG_DONE" } else { "DAG_BLOCKED" },
            "snapshot": get_snapshot(cwd, session_id)?
        }));
    };
    let ready_node = dag_nodes(&dag)[ready_index].clone();
    let ready_id = field_str(&ready_node, "id").unwrap_or_default();
    let ready_type = field_str(&ready_node, "type").unwrap_or_default();

    if ready_type == "human_review" {
        mark_node_waiting_review(&mut dag, &mut state, &ready_id);
        record_event(&mut state, "node_waiting_review", json!({ "id": ready_id }));
        save_dag(&paths, &dag)?;
        save_state(&paths, &mut state)?;
        return Ok(json!({
            "status": "WAITING_REVIEW",
            "node": ready_node,
            "question": field_str(&ready_node, "question").unwrap_or_else(|| "Review is required before continuing.".to_string()),
            "snapshot": get_snapshot(cwd, session_id)?
        }));
    }

    if ready_type == "map" {
        mark_node_running(&mut dag, &mut state, &ready_id);
        let Some(task_index) = first_open_task_index(&tasks) else {
            let counts = task_counts(&tasks);
            if count_value(&counts, "blocked") > 0
                || count_value(&counts, "waiting_review") > 0
                || count_value(&counts, "failed") > 0
            {
                if let Some(index) = node_index_by_id(dag_nodes_mut(&mut dag), &ready_id) {
                    set_field(&mut dag_nodes_mut(&mut dag)[index], "status", json!("blocked"));
                }
                unique_push_state(&mut state, "blocked", &ready_id);
                record_event(&mut state, "map_blocked", json!({ "id": ready_id, "counts": counts }));
                save_dag(&paths, &dag)?;
                save_state(&paths, &mut state)?;
                return Ok(json!({
                    "status": "DAG_BLOCKED",
                    "node": ready_node,
                    "counts": counts,
                    "snapshot": get_snapshot(cwd, session_id)?
                }));
            }
            mark_node_done(&mut dag, &mut state, &ready_id);
            record_event(&mut state, "map_done", json!({ "id": ready_id }));
            save_dag(&paths, &dag)?;
            save_state(&paths, &mut state)?;
            return Ok(json!({
                "status": "NODE_DONE",
                "node": ready_node,
                "snapshot": get_snapshot(cwd, session_id)?
            }));
        };

        {
            let task = &mut tasks[task_index];
            set_field(task, "status", json!("running"));
            set_field(task, "started_at", json!(now()));
            let attempts = task.get("attempts").and_then(Value::as_u64).unwrap_or(0) + 1;
            set_field(task, "attempts", json!(attempts));
            if let Some(task_id) = field_str(task, "id") {
                state_tasks_mut(&mut state).insert("current".to_string(), json!(task_id));
            }
        }

        if field_bool(&tasks[task_index], "requires_decision") && tasks[task_index].get("resolution").is_none() {
            let task_id = field_str(&tasks[task_index], "id").unwrap_or_default();
            let question = field_str(&tasks[task_index], "question").unwrap_or_else(|| "Task needs a user decision.".to_string());
            let result = json!({
                "status": "blocked",
                "task_id": task_id,
                "summary": question,
                "question": field_str(&tasks[task_index], "question"),
                "options": tasks[task_index].get("options").cloned().unwrap_or_else(|| json!([]))
            });
            let run = write_run(&paths, &task_id, &result)?;
            let task = &mut tasks[task_index];
            set_field(task, "status", json!("blocked"));
            set_field(task, "blocked_at", json!(now()));
            set_field(task, "result", result);
            set_field(task, "latest_run", run.clone());
            state_tasks_mut(&mut state).insert("current".to_string(), Value::Null);
            record_event(&mut state, "task_blocked", json!({ "id": task_id, "question": question }));
            write_tasks(&paths.tasks, &tasks)?;
            save_dag(&paths, &dag)?;
            save_state(&paths, &mut state)?;
            return Ok(json!({
                "status": "TASK_BLOCKED",
                "task": tasks[task_index],
                "run": run,
                "snapshot": get_snapshot(cwd, session_id)?
            }));
        }

        let task_id = field_str(&tasks[task_index], "id").unwrap_or_default();
        let result = json!({
            "status": "done",
            "task_id": task_id,
            "changed_file": field_str(&tasks[task_index], "generated_file"),
            "summary": "MVP simulation completed this task. Pi worker integration can replace this step.",
            "uncertainty": tasks[task_index].get("resolution").and_then(|value| value.get("answer")).and_then(Value::as_str).map(|answer| format!("User answer: {answer}"))
        });
        let run = write_run(&paths, &task_id, &result)?;
        {
            let task = &mut tasks[task_index];
            set_field(task, "status", json!("done"));
            set_field(task, "completed_at", json!(now()));
            set_field(task, "result", result);
            set_field(task, "latest_run", run.clone());
        }
        state_tasks_mut(&mut state).insert("current".to_string(), Value::Null);
        record_event(&mut state, "task_done", json!({ "id": task_id }));
        write_tasks(&paths.tasks, &tasks)?;
        save_dag(&paths, &dag)?;
        save_state(&paths, &mut state)?;
        return Ok(json!({
            "status": "TASK_DONE",
            "task": tasks[task_index],
            "run": run,
            "snapshot": get_snapshot(cwd, session_id)?
        }));
    }

    if ready_type == "summary" {
        mark_node_running(&mut dag, &mut state, &ready_id);
        let result = json!({
            "status": "done",
            "node_id": ready_id,
            "summary": "All runnable tasks are complete.",
            "task_counts": task_counts(&tasks)
        });
        let run = write_run(&paths, &ready_id, &result)?;
        mark_node_done(&mut dag, &mut state, &ready_id);
        record_event(&mut state, "summary_done", json!({ "id": ready_id }));
        save_dag(&paths, &dag)?;
        save_state(&paths, &mut state)?;
        return Ok(json!({
            "status": "NODE_DONE",
            "node": ready_node,
            "run": run,
            "snapshot": get_snapshot(cwd, session_id)?
        }));
    }

    mark_node_done(&mut dag, &mut state, &ready_id);
    record_event(&mut state, "node_done", json!({ "id": ready_id, "type": ready_type }));
    save_dag(&paths, &dag)?;
    save_state(&paths, &mut state)?;
    Ok(json!({
        "status": "NODE_DONE",
        "node": ready_node,
        "snapshot": get_snapshot(cwd, session_id)?
    }))
}

fn run_until_blocked(cwd: &str, limit: u64, session_id: &str) -> Result<Value, String> {
    let mut results = Vec::new();
    for _ in 0..limit {
        let result = run_next(cwd, session_id)?;
        let status = field_str(&result, "status").unwrap_or_default();
        results.push(json!({
            "status": status,
            "node": result.get("node").and_then(|node| node.get("id")).cloned().unwrap_or(Value::Null),
            "task": result.get("task").and_then(|task| task.get("id")).cloned().unwrap_or(Value::Null)
        }));
        if ["WAITING_REVIEW", "TASK_BLOCKED", "DAG_BLOCKED", "DAG_DONE", "NO_DAG"].contains(&status.as_str()) {
            return Ok(json!({
                "status": status,
                "results": results,
                "snapshot": get_snapshot(cwd, session_id)?
            }));
        }
    }
    Ok(json!({
        "status": "LIMIT_REACHED",
        "results": results,
        "snapshot": get_snapshot(cwd, session_id)?
    }))
}

fn orchestrators() -> &'static Mutex<HashMap<String, OrchestratorProcess>> {
    ORCHESTRATORS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn orchestrator_key(cwd: &str, session_id: &str) -> String {
    let paths = flow_paths(cwd, session_id);
    format!("{}::{}", paths.root.display(), paths.session_id)
}

fn orchestrator_dir(cwd: &str, session_id: &str) -> PathBuf {
    flow_paths(cwd, session_id).flow_dir.join(ORCHESTRATOR_DIR)
}

fn orchestrator_record_path(cwd: &str, session_id: &str) -> PathBuf {
    orchestrator_dir(cwd, session_id).join(ORCHESTRATOR_RECORD_FILE)
}

fn orchestrator_log_path(cwd: &str, session_id: &str) -> PathBuf {
    orchestrator_dir(cwd, session_id).join(ORCHESTRATOR_LOG_FILE)
}

fn read_tail_lines(path: &Path, limit: usize) -> Vec<String> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut lines: Vec<String> = text.lines().rev().take(limit).map(ToString::to_string).collect();
    lines.reverse();
    lines
}

fn read_tail_text(path: &Path, max_bytes: usize) -> String {
    let Ok(bytes) = fs::read(path) else {
        return String::new();
    };
    let start = bytes.len().saturating_sub(max_bytes);
    String::from_utf8_lossy(&bytes[start..]).into_owned()
}

fn read_terminal_tail_text(path: &Path, max_bytes: usize) -> String {
    let text = read_tail_text(path, max_bytes);
    text
        .lines()
        .filter(|line| !line.starts_with("[system]") && !line.starts_with("[input]"))
        .collect::<Vec<_>>()
        .join("\n")
}

fn write_orchestrator_record(process: &OrchestratorProcess, status: &str, attached: bool) -> Result<Value, String> {
    let connections = process
        .clients
        .lock()
        .map(|clients| clients.len())
        .unwrap_or_default();
    let record = json!({
        "pid": process.pid,
        "cwd": process.cwd.clone(),
        "session_id": process.session_id.clone(),
        "command": process.command.clone(),
        "args": process.args.clone(),
        "status": status,
        "attached": attached,
        "connections": connections,
        "log_path": process.log_path.to_string_lossy(),
        "started_at": process.started_at.clone(),
        "pty": {
            "cols": process.size.cols,
            "rows": process.size.rows,
            "pixel_width": process.size.pixel_width,
            "pixel_height": process.size.pixel_height
        },
        "updated_at": now()
    });
    write_json_atomic(&orchestrator_record_path(&process.cwd, &process.session_id), &record)?;
    Ok(record)
}

fn read_orchestrator_record(cwd: &str, session_id: &str) -> Option<Value> {
    read_json(&orchestrator_record_path(cwd, session_id), Value::Null)
        .ok()
        .filter(|value| value.is_object())
}

fn wait_for_process_exit(pid: u32) -> bool {
    for _ in 0..20 {
        if !process_alive(pid) {
            return true;
        }
        thread::sleep(Duration::from_millis(100));
    }
    !process_alive(pid)
}

fn record_pid(record: &Value) -> Option<u32> {
    record
        .get("pid")
        .and_then(Value::as_u64)
        .and_then(|pid| u32::try_from(pid).ok())
}

fn update_orchestrator_record(cwd: &str, session_id: &str, mut record: Value, status: &str, attached: bool) -> Result<Value, String> {
    if let Some(object) = record.as_object_mut() {
        object.insert("status".to_string(), json!(status));
        object.insert("attached".to_string(), json!(attached));
        object.insert("updated_at".to_string(), json!(now()));
    }
    write_json_atomic(&orchestrator_record_path(cwd, session_id), &record)?;
    Ok(record)
}

#[cfg(unix)]
fn process_alive(pid: u32) -> bool {
    Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(unix)]
fn terminate_process(pid: u32) -> bool {
    Command::new("kill")
        .arg("-TERM")
        .arg(pid.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(unix)]
fn process_exit_status(pid: u32) -> Option<String> {
    let mut status: libc::c_int = 0;
    let result = unsafe { libc::waitpid(pid as libc::pid_t, &mut status, libc::WNOHANG) };
    if result == pid as libc::pid_t {
        Some(format!("stopped:{status}"))
    } else {
        None
    }
}

#[cfg(not(unix))]
fn process_exit_status(pid: u32) -> Option<String> {
    if process_alive(pid) {
        None
    } else {
        Some("stopped".to_string())
    }
}

#[cfg(unix)]
fn stop_managed_process(pid: u32) {
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGTERM);
        let mut status = 0;
        libc::waitpid(pid as libc::pid_t, &mut status, 0);
    }
}

#[cfg(not(unix))]
fn stop_managed_process(pid: u32) {
    let _ = terminate_process(pid);
    let _ = wait_for_process_exit(pid);
}

#[cfg(unix)]
fn resize_process_pty(process: &mut OrchestratorProcess, size: PtySize) -> Result<(), String> {
    let Some(handle) = process.resize_handle.as_ref() else {
        return Ok(());
    };
    let mut winsize = libc::winsize {
        ws_row: size.rows,
        ws_col: size.cols,
        ws_xpixel: size.pixel_width,
        ws_ypixel: size.pixel_height,
    };
    let result = unsafe { libc::ioctl(handle.as_raw_fd(), libc::TIOCSWINSZ, &mut winsize) };
    if result == 0 {
        Ok(())
    } else {
        Err(format!("调整编排者终端大小失败: {}", std::io::Error::last_os_error()))
    }
}

#[cfg(not(unix))]
fn resize_process_pty(_process: &mut OrchestratorProcess, _size: PtySize) -> Result<(), String> {
    Ok(())
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}")])
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
        .unwrap_or(false)
}

#[cfg(windows)]
fn terminate_process(pid: u32) -> bool {
    Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn home_dir_candidates() -> Vec<PathBuf> {
    let mut homes = Vec::new();
    for key in ["HOME", "USERPROFILE"] {
        if let Ok(value) = env::var(key) {
            let path = PathBuf::from(value);
            if path.is_dir() && !homes.iter().any(|existing| existing == &path) {
                homes.push(path);
            }
        }
    }
    for key in ["USER", "LOGNAME"] {
        if let Ok(value) = env::var(key) {
            let path = PathBuf::from("/Users").join(value);
            if path.is_dir() && !homes.iter().any(|existing| existing == &path) {
                homes.push(path);
            }
        }
    }
    homes
}

fn default_orchestrator_command() -> String {
    for key in ["PI_GHOST_ORCHESTRATOR_COMMAND", "PI_GHOST_DAG_ORCHESTRATOR"] {
        if let Some(command) = env::var(key)
            .ok()
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
        {
            return command;
        }
    }
    for home in home_dir_candidates() {
        let launcher = home.join(".local/bin/pi-ghost");
        if launcher.is_file() {
            return launcher.to_string_lossy().into_owned();
        }
    }
    "pi-ghost".to_string()
}

fn push_path_dir(dirs: &mut Vec<PathBuf>, path: PathBuf) {
    if path.is_dir() && !dirs.iter().any(|existing| existing == &path) {
        dirs.push(path);
    }
}

fn push_first_fnm_tool_dir(dirs: &mut Vec<PathBuf>, home: &Path, tool: &str) {
    let fnm_dir = home.join(".local/state/fnm_multishells");
    let Ok(entries) = fs::read_dir(fnm_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let bin = entry.path().join("bin");
        if bin.join(tool).is_file() {
            push_path_dir(dirs, bin);
            return;
        }
    }
}

fn orchestrator_path_env(command: &str) -> String {
    let mut dirs = Vec::new();
    let command_name = Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command);
    if let Some(parent) = Path::new(command).parent() {
        push_path_dir(&mut dirs, parent.to_path_buf());
    }
    for home in home_dir_candidates() {
        push_path_dir(&mut dirs, home.join(".local/bin"));
        push_path_dir(&mut dirs, home.join(".cargo/bin"));
        push_first_fnm_tool_dir(&mut dirs, &home, command_name);
        if command_name != "pi" {
            push_first_fnm_tool_dir(&mut dirs, &home, "pi");
        }
    }
    push_path_dir(&mut dirs, PathBuf::from("/opt/homebrew/bin"));
    push_path_dir(&mut dirs, PathBuf::from("/usr/local/bin"));
    push_path_dir(&mut dirs, PathBuf::from("/usr/bin"));
    push_path_dir(&mut dirs, PathBuf::from("/bin"));
    push_path_dir(&mut dirs, PathBuf::from("/usr/sbin"));
    push_path_dir(&mut dirs, PathBuf::from("/sbin"));

    let parts: Vec<String> = dirs
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    let joined = parts.join(":");
    if joined.len() > 16_384 {
        "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin".to_string()
    } else {
        joined
    }
}

fn string_array(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(ToString::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn body_u16(body: &Value, key: &str, default_value: u16) -> u16 {
    body
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|value| u16::try_from(value).ok())
        .filter(|value| *value > 0)
        .unwrap_or(default_value)
}

fn pty_size_from_body(body: &Value) -> PtySize {
    PtySize {
        cols: body_u16(body, "cols", 100),
        rows: body_u16(body, "rows", 28),
        pixel_width: body_u16(body, "pixel_width", 0),
        pixel_height: body_u16(body, "pixel_height", 0),
    }
}

fn append_pty_to_log<R: Read + Send + 'static>(
    mut reader: R,
    log_path: PathBuf,
    clients: std::sync::Arc<Mutex<Vec<(String, mpsc::Sender<Vec<u8>>)>>>,
) {
    thread::spawn(move || {
        let mut buffer = [0_u8; 4096];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let bytes = buffer[..count].to_vec();
                    let text = String::from_utf8_lossy(&bytes);
                    let _ = append_text(&log_path, &text);
                    if let Ok(mut clients) = clients.lock() {
                        clients.retain(|(_, client)| client.send(bytes.clone()).is_ok());
                    }
                }
                Err(error) => {
                    let _ = append_text(&log_path, &format!("\npty read error: {error}\n"));
                    break;
                }
            }
        }
    });
}

fn cleanup_finished_orchestrator(process: &mut OrchestratorProcess) -> Result<bool, String> {
    if let Some(status) = process_exit_status(process.pid) {
        let _ = write_orchestrator_record(process, &status, false);
        return Ok(true);
    }
    Ok(false)
}

fn orchestrator_status(cwd: &str, session_id: &str) -> Result<Value, String> {
    let key = orchestrator_key(cwd, session_id);
    let log_path = orchestrator_log_path(cwd, session_id);
    let mut map = orchestrators().lock().map_err(|_| "orchestrator lock poisoned".to_string())?;
    if let Some(process) = map.get_mut(&key) {
        if cleanup_finished_orchestrator(process)? {
            map.remove(&key);
        } else {
            let record = write_orchestrator_record(process, "running", true)?;
            return Ok(json!({
                "running": true,
                "attached": true,
                "record": record,
                "lines": read_tail_lines(&log_path, 400),
                "text": read_tail_text(&log_path, 262_144)
            }));
        }
    }
    drop(map);

    let mut record = read_orchestrator_record(cwd, session_id);
    let running = record
        .as_ref()
        .and_then(record_pid)
        .map(process_alive)
        .unwrap_or(false);
    if let Some(existing) = record.take() {
        let status = if running { "running" } else { "stopped" };
        record = Some(update_orchestrator_record(cwd, session_id, existing, status, false)?);
    }
    Ok(json!({
        "running": running,
        "attached": false,
        "record": record,
        "lines": read_tail_lines(&log_path, 400),
        "text": read_tail_text(&log_path, 262_144)
    }))
}

fn start_orchestrator(cwd: &str, session_id: &str, body: &Value) -> Result<Value, String> {
    let key = orchestrator_key(cwd, session_id);
    let force = body.get("force").and_then(Value::as_bool).unwrap_or(false);
    {
        let mut map = orchestrators().lock().map_err(|_| "orchestrator lock poisoned".to_string())?;
        let mut remove_existing = false;
        if let Some(process) = map.get_mut(&key) {
            if !cleanup_finished_orchestrator(process)? {
                if force {
                    stop_managed_process(process.pid);
                    let _ = write_orchestrator_record(process, "stopped", false);
                    remove_existing = true;
                } else {
                    let record = write_orchestrator_record(process, "running", true)?;
                    return Ok(json!({
                        "running": true,
                        "attached": true,
                        "record": record,
                        "lines": read_tail_lines(&process.log_path, 400),
                        "text": read_tail_text(&process.log_path, 262_144)
                    }));
                }
            } else {
                remove_existing = true;
            }
        }
        if remove_existing {
            map.remove(&key);
        }
    }

    if let Some(record) = read_orchestrator_record(cwd, session_id) {
        if let Some(pid) = record_pid(&record) {
            if process_alive(pid) {
                if !force {
                    let _ = terminate_process(pid);
                    let _ = wait_for_process_exit(pid);
                    let _ = update_orchestrator_record(cwd, session_id, record, "stopped", false)?;
                } else {
                    let _ = terminate_process(pid);
                    if !wait_for_process_exit(pid) {
                        return Err(format!("旧编排者仍在运行，无法 renew: pid {pid}"));
                    }
                    let _ = update_orchestrator_record(cwd, session_id, record, "stopped", false)?;
                }
            }
        }
    }

    let paths = flow_paths(cwd, session_id);
    let command = body
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(default_orchestrator_command);
    let args = string_array(body.get("args"));
    let log_path = orchestrator_log_path(cwd, session_id);
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("无法创建编排者目录 {}: {error}", parent.display()))?;
    }
    truncate_file(&log_path)?;
    let size = pty_size_from_body(body);
    let (pid, reader, writer, resize_handle) =
        spawn_terminal_process(&command, &args, &paths.root, &paths.session_id, size)?;
    let clients = std::sync::Arc::new(Mutex::new(Vec::new()));
    let mut process = OrchestratorProcess {
        pid,
        cwd: paths.root.to_string_lossy().into_owned(),
        session_id: paths.session_id.clone(),
        command,
        args,
        log_path: log_path.clone(),
        started_at: now(),
        writer,
        clients: clients.clone(),
        #[cfg(unix)]
        resize_handle,
        size,
    };
    append_pty_to_log(reader, log_path.clone(), clients);
    thread::sleep(Duration::from_millis(180));
    if cleanup_finished_orchestrator(&mut process)? {
        return Ok(json!({
            "running": false,
            "attached": false,
            "record": read_orchestrator_record(cwd, session_id),
            "lines": read_tail_lines(&log_path, 400),
            "text": read_tail_text(&log_path, 262_144)
        }));
    }
    let record = write_orchestrator_record(&process, "running", true)?;
    orchestrators()
        .lock()
        .map_err(|_| "orchestrator lock poisoned".to_string())?
        .insert(key, process);
    Ok(json!({
        "running": true,
        "attached": true,
        "record": record,
        "lines": read_tail_lines(&log_path, 400),
        "text": read_tail_text(&log_path, 262_144)
    }))
}

fn write_orchestrator_input(cwd: &str, session_id: &str, data: &str) -> Result<Value, String> {
    let key = orchestrator_key(cwd, session_id);
    let mut map = orchestrators().lock().map_err(|_| "orchestrator lock poisoned".to_string())?;
    let process = map
        .get_mut(&key)
        .ok_or_else(|| "编排者未运行，或当前后台服务没有附着到这个会话。".to_string())?;
    if cleanup_finished_orchestrator(process)? {
        map.remove(&key);
        return Err("编排者已经退出。".to_string());
    }
    process
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| process.writer.flush())
        .map_err(|error| format!("发送给编排者失败: {error}"))?;
    let record = write_orchestrator_record(process, "running", true)?;
    Ok(json!({
        "running": true,
        "attached": true,
        "record": record,
        "lines": read_tail_lines(&process.log_path, 400),
        "text": read_tail_text(&process.log_path, 262_144)
    }))
}

fn add_orchestrator_client(cwd: &str, session_id: &str) -> Result<(String, mpsc::Receiver<Vec<u8>>), String> {
    let key = orchestrator_key(cwd, session_id);
    let client_id = safe_run_id();
    let (tx, rx) = mpsc::channel();
    let mut map = orchestrators().lock().map_err(|_| "orchestrator lock poisoned".to_string())?;
    let process = map
        .get_mut(&key)
        .ok_or_else(|| "编排者未运行，或当前后台服务没有附着到这个会话。".to_string())?;
    if cleanup_finished_orchestrator(process)? {
        map.remove(&key);
        return Err("编排者已经退出。".to_string());
    }
    process
        .clients
        .lock()
        .map_err(|_| "orchestrator client lock poisoned".to_string())?
        .push((client_id.clone(), tx));
    let _ = write_orchestrator_record(process, "running", true);
    Ok((client_id, rx))
}

fn remove_orchestrator_client(cwd: &str, session_id: &str, client_id: &str) {
    let key = orchestrator_key(cwd, session_id);
    let Ok(mut map) = orchestrators().lock() else {
        return;
    };
    if let Some(process) = map.get_mut(&key) {
        if let Ok(mut clients) = process.clients.lock() {
            clients.retain(|(id, _)| id != client_id);
        }
        let _ = write_orchestrator_record(process, "running", true);
    }
}

fn send_orchestrator(cwd: &str, session_id: &str, message: &str) -> Result<Value, String> {
    let input = if message.ends_with('\n') {
        message.replace('\n', "\r")
    } else {
        format!("{message}\r")
    };
    let _ = write_orchestrator_input(cwd, session_id, &input)?;
    orchestrator_status(cwd, session_id)
}

fn resize_orchestrator(cwd: &str, session_id: &str, body: &Value) -> Result<Value, String> {
    let key = orchestrator_key(cwd, session_id);
    let mut map = orchestrators().lock().map_err(|_| "orchestrator lock poisoned".to_string())?;
    let process = map
        .get_mut(&key)
        .ok_or_else(|| "编排者未运行，或当前后台服务没有附着到这个会话。".to_string())?;
    let size = pty_size_from_body(body);
    resize_process_pty(process, size)?;
    process.size = size;
    let record = write_orchestrator_record(process, "running", true)?;
    Ok(json!({
        "running": true,
        "attached": true,
        "record": record,
        "lines": read_tail_lines(&process.log_path, 400),
        "text": read_tail_text(&process.log_path, 262_144)
    }))
}

fn stop_orchestrator(cwd: &str, session_id: &str) -> Result<Value, String> {
    let key = orchestrator_key(cwd, session_id);
    let log_path = orchestrator_log_path(cwd, session_id);
    let mut map = orchestrators().lock().map_err(|_| "orchestrator lock poisoned".to_string())?;
    if let Some(process) = map.remove(&key) {
        stop_managed_process(process.pid);
        let _ = write_orchestrator_record(&process, "stopped", false);
    } else if let Some(record) = read_orchestrator_record(cwd, session_id) {
        if let Some(pid) = record_pid(&record) {
            if process_alive(pid) {
                let _ = append_text(&log_path, &format!("\n[system] 停止未附着的编排者: pid {pid}\n"));
                let _ = terminate_process(pid);
                let _ = wait_for_process_exit(pid);
            }
        }
        let _ = update_orchestrator_record(cwd, session_id, record, "stopped", false);
    }
    Ok(json!({
        "running": false,
        "attached": false,
        "record": read_orchestrator_record(cwd, session_id),
        "lines": read_tail_lines(&log_path, 400),
        "text": read_tail_text(&log_path, 262_144)
    }))
}

fn percent_decode(value: &str) -> String {
    let mut output = Vec::new();
    let bytes = value.as_bytes();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let Ok(hex) = u8::from_str_radix(&value[index + 1..index + 3], 16) {
                output.push(hex);
                index += 3;
                continue;
            }
        }
        output.push(if bytes[index] == b'+' { b' ' } else { bytes[index] });
        index += 1;
    }
    String::from_utf8_lossy(&output).into_owned()
}

fn parse_target(target: &str) -> (String, HashMap<String, String>) {
    let mut parts = target.splitn(2, '?');
    let path = parts.next().unwrap_or("/").to_string();
    let mut query = HashMap::new();
    if let Some(raw_query) = parts.next() {
        for pair in raw_query.split('&').filter(|pair| !pair.is_empty()) {
            let mut item = pair.splitn(2, '=');
            let key = percent_decode(item.next().unwrap_or_default());
            let value = percent_decode(item.next().unwrap_or_default());
            query.insert(key, value);
        }
    }
    (path, query)
}

fn find_header_end(buffer: &[u8]) -> Option<usize> {
    buffer.windows(4).position(|window| window == b"\r\n\r\n").map(|index| index + 4)
}

fn read_request(stream: &mut TcpStream) -> Result<Request, String> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok();
    let mut buffer = Vec::new();
    let mut temp = [0_u8; 4096];
    let header_end = loop {
        let count = stream.read(&mut temp).map_err(|error| format!("读取请求失败: {error}"))?;
        if count == 0 {
            return Err("空请求".to_string());
        }
        buffer.extend_from_slice(&temp[..count]);
        if let Some(index) = find_header_end(&buffer) {
            break index;
        }
        if buffer.len() > 1024 * 1024 {
            return Err("请求头过大".to_string());
        }
    };
    let raw_headers = String::from_utf8_lossy(&buffer[..header_end]);
    let mut lines = raw_headers.lines();
    let request_line = lines.next().ok_or_else(|| "请求行缺失".to_string())?;
    let mut request_parts = request_line.split_whitespace();
    let method = request_parts.next().unwrap_or_default().to_string();
    let target = request_parts.next().unwrap_or("/").to_string();
    let mut headers = HashMap::new();
    let mut content_length = 0_usize;
    for line in lines {
        if let Some((name, value)) = line.split_once(':') {
            let key = name.trim().to_ascii_lowercase();
            let value = value.trim().to_string();
            if name.eq_ignore_ascii_case("content-length") {
                content_length = value.parse::<usize>().unwrap_or(0);
            }
            headers.insert(key, value);
        }
    }
    while buffer.len().saturating_sub(header_end) < content_length {
        let count = stream.read(&mut temp).map_err(|error| format!("读取请求 body 失败: {error}"))?;
        if count == 0 {
            break;
        }
        buffer.extend_from_slice(&temp[..count]);
    }
    let body_end = header_end + content_length.min(buffer.len().saturating_sub(header_end));
    let body = buffer[header_end..body_end].to_vec();
    let (path, query) = parse_target(&target);
    Ok(Request {
        method,
        path,
        query,
        headers,
        body,
    })
}

fn write_response(stream: &mut TcpStream, status: u16, content_type: &str, body: &[u8]) -> Result<(), String> {
    let status_text = match status {
        200 => "OK",
        204 => "No Content",
        403 => "Forbidden",
        404 => "Not Found",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let headers = format!(
        "HTTP/1.1 {status} {status_text}\r\ncontent-type: {content_type}\r\ncontent-length: {}\r\ncache-control: no-store\r\naccess-control-allow-origin: *\r\naccess-control-allow-methods: GET,POST,OPTIONS\r\naccess-control-allow-headers: content-type\r\nconnection: close\r\n\r\n",
        body.len()
    );
    stream
        .write_all(headers.as_bytes())
        .and_then(|_| stream.write_all(body))
        .map_err(|error| format!("写入响应失败: {error}"))
}

fn send_json(stream: &mut TcpStream, status: u16, value: Value) -> Result<(), String> {
    let body = serde_json::to_vec_pretty(&value).map_err(|error| format!("序列化响应失败: {error}"))?;
    write_response(stream, status, "application/json; charset=utf-8", &body)
}

struct WsFrame {
    opcode: u8,
    payload: Vec<u8>,
}

fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        output.push(TABLE[(b0 >> 2) as usize] as char);
        output.push(TABLE[(((b0 & 0b0000_0011) << 4) | (b1 >> 4)) as usize] as char);
        if chunk.len() > 1 {
            output.push(TABLE[(((b1 & 0b0000_1111) << 2) | (b2 >> 6)) as usize] as char);
        } else {
            output.push('=');
        }
        if chunk.len() > 2 {
            output.push(TABLE[(b2 & 0b0011_1111) as usize] as char);
        } else {
            output.push('=');
        }
    }
    output
}

fn sha1_digest(input: &[u8]) -> [u8; 20] {
    let mut h0 = 0x6745_2301_u32;
    let mut h1 = 0xEFCD_AB89_u32;
    let mut h2 = 0x98BA_DCFE_u32;
    let mut h3 = 0x1032_5476_u32;
    let mut h4 = 0xC3D2_E1F0_u32;

    let mut message = input.to_vec();
    let bit_len = (message.len() as u64) * 8;
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in message.chunks(64) {
        let mut words = [0_u32; 80];
        for index in 0..16 {
            let offset = index * 4;
            words[index] = u32::from_be_bytes([
                chunk[offset],
                chunk[offset + 1],
                chunk[offset + 2],
                chunk[offset + 3],
            ]);
        }
        for index in 16..80 {
            words[index] = (words[index - 3] ^ words[index - 8] ^ words[index - 14] ^ words[index - 16]).rotate_left(1);
        }

        let mut a = h0;
        let mut b = h1;
        let mut c = h2;
        let mut d = h3;
        let mut e = h4;
        for (index, word) in words.iter().enumerate() {
            let (f, k) = match index {
                0..=19 => ((b & c) | ((!b) & d), 0x5A82_7999),
                20..=39 => (b ^ c ^ d, 0x6ED9_EBA1),
                40..=59 => ((b & c) | (b & d) | (c & d), 0x8F1B_BCDC),
                _ => (b ^ c ^ d, 0xCA62_C1D6),
            };
            let temp = a
                .rotate_left(5)
                .wrapping_add(f)
                .wrapping_add(e)
                .wrapping_add(k)
                .wrapping_add(*word);
            e = d;
            d = c;
            c = b.rotate_left(30);
            b = a;
            a = temp;
        }
        h0 = h0.wrapping_add(a);
        h1 = h1.wrapping_add(b);
        h2 = h2.wrapping_add(c);
        h3 = h3.wrapping_add(d);
        h4 = h4.wrapping_add(e);
    }

    let mut output = [0_u8; 20];
    output[0..4].copy_from_slice(&h0.to_be_bytes());
    output[4..8].copy_from_slice(&h1.to_be_bytes());
    output[8..12].copy_from_slice(&h2.to_be_bytes());
    output[12..16].copy_from_slice(&h3.to_be_bytes());
    output[16..20].copy_from_slice(&h4.to_be_bytes());
    output
}

fn websocket_accept_key(key: &str) -> String {
    let mut input = key.as_bytes().to_vec();
    input.extend_from_slice(b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
    base64_encode(&sha1_digest(&input))
}

fn write_websocket_handshake(stream: &mut TcpStream, request: &Request) -> Result<(), String> {
    let key = request
        .headers
        .get("sec-websocket-key")
        .ok_or_else(|| "WebSocket 缺少 Sec-WebSocket-Key".to_string())?;
    let accept = websocket_accept_key(key);
    let response = format!(
        "HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: {accept}\r\n\r\n"
    );
    stream
        .write_all(response.as_bytes())
        .and_then(|_| stream.flush())
        .map_err(|error| format!("WebSocket 握手失败: {error}"))
}

fn read_ws_frame(stream: &mut TcpStream) -> Result<WsFrame, String> {
    let mut header = [0_u8; 2];
    stream
        .read_exact(&mut header)
        .map_err(|error| format!("读取 WebSocket 帧失败: {error}"))?;
    let opcode = header[0] & 0x0f;
    let masked = header[1] & 0x80 != 0;
    let mut length = u64::from(header[1] & 0x7f);
    if length == 126 {
        let mut bytes = [0_u8; 2];
        stream
            .read_exact(&mut bytes)
            .map_err(|error| format!("读取 WebSocket 长度失败: {error}"))?;
        length = u64::from(u16::from_be_bytes(bytes));
    } else if length == 127 {
        let mut bytes = [0_u8; 8];
        stream
            .read_exact(&mut bytes)
            .map_err(|error| format!("读取 WebSocket 长度失败: {error}"))?;
        length = u64::from_be_bytes(bytes);
    }
    if length > 16 * 1024 * 1024 {
        return Err("WebSocket 帧过大".to_string());
    }
    let mut mask = [0_u8; 4];
    if masked {
        stream
            .read_exact(&mut mask)
            .map_err(|error| format!("读取 WebSocket mask 失败: {error}"))?;
    }
    let mut payload = vec![0_u8; length as usize];
    if !payload.is_empty() {
        stream
            .read_exact(&mut payload)
            .map_err(|error| format!("读取 WebSocket payload 失败: {error}"))?;
    }
    if masked {
        for (index, byte) in payload.iter_mut().enumerate() {
            *byte ^= mask[index % 4];
        }
    }
    Ok(WsFrame { opcode, payload })
}

fn write_ws_frame(stream: &mut TcpStream, opcode: u8, payload: &[u8]) -> Result<(), String> {
    let mut header = Vec::with_capacity(10);
    header.push(0x80 | (opcode & 0x0f));
    if payload.len() < 126 {
        header.push(payload.len() as u8);
    } else if payload.len() <= u16::MAX as usize {
        header.push(126);
        header.extend_from_slice(&(payload.len() as u16).to_be_bytes());
    } else {
        header.push(127);
        header.extend_from_slice(&(payload.len() as u64).to_be_bytes());
    }
    stream
        .write_all(&header)
        .and_then(|_| stream.write_all(payload))
        .and_then(|_| stream.flush())
        .map_err(|error| format!("写入 WebSocket 帧失败: {error}"))
}

fn query_u16(query: &HashMap<String, String>, key: &str, default_value: u16) -> u16 {
    query
        .get(key)
        .and_then(|value| value.parse::<u16>().ok())
        .filter(|value| *value > 0)
        .unwrap_or(default_value)
}

fn pty_size_from_query(query: &HashMap<String, String>) -> PtySize {
    PtySize {
        cols: query_u16(query, "cols", 100),
        rows: query_u16(query, "rows", 28),
        pixel_width: query_u16(query, "pixel_width", 0),
        pixel_height: query_u16(query, "pixel_height", 0),
    }
}

fn resolve_command_path(command: &str, path_env: &str) -> String {
    if command.contains('/') {
        return command.to_string();
    }
    for dir in path_env.split(':').filter(|value| !value.is_empty()) {
        let candidate = Path::new(dir).join(command);
        if candidate.is_file() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    command.to_string()
}

#[cfg(unix)]
fn spawn_terminal_process(
    command: &str,
    args: &[String],
    cwd: &Path,
    session_id: &str,
    size: PtySize,
) -> Result<(u32, Box<dyn Read + Send>, Box<dyn Write + Send>, Option<File>), String> {
    let path_env = orchestrator_path_env(command);
    let exec_path = resolve_command_path(command, &path_env);
    let mut env_values = vec![
        ("PI_GHOST_DAG_SESSION_ID", session_id.to_string()),
        ("PATH", path_env),
        ("TERM", "xterm-256color".to_string()),
        ("COLORTERM", "truecolor".to_string()),
        ("COLUMNS", size.cols.to_string()),
        ("LINES", size.rows.to_string()),
        ("TMPDIR", "/tmp".to_string()),
        ("SHELL", "/bin/zsh".to_string()),
    ];
    if let Some(home) = home_dir_candidates().into_iter().next() {
        let home_text = home.to_string_lossy().into_owned();
        let user = home
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("user")
            .to_string();
        env_values.push(("HOME", home_text));
        env_values.push(("USER", user.clone()));
        env_values.push(("LOGNAME", user));
    }
    let env_c: Vec<CString> = env_values
        .iter()
        .map(|(key, value)| {
            CString::new(format!("{key}={value}"))
                .map_err(|_| format!("环境变量包含 NUL: {key}"))
        })
        .collect::<Result<_, String>>()?;
    let mut envp: Vec<*const libc::c_char> = env_c.iter().map(|value| value.as_ptr()).collect();
    envp.push(std::ptr::null());

    let cwd_c = CString::new(cwd.as_os_str().as_bytes())
        .map_err(|_| format!("工作区路径包含 NUL: {}", cwd.display()))?;
    let exec_path_c = CString::new(exec_path.as_str())
        .map_err(|_| format!("命令路径包含 NUL: {exec_path}"))?;
    let command_c = CString::new(command).map_err(|_| format!("命令包含 NUL: {command}"))?;
    let perror_label = CString::new("execve").expect("static label");
    let mut argv_c = Vec::with_capacity(args.len() + 1);
    argv_c.push(command_c);
    for arg in args {
        argv_c.push(CString::new(arg.as_str()).map_err(|_| format!("命令参数包含 NUL: {arg}"))?);
    }
    let mut argv: Vec<*const libc::c_char> = argv_c.iter().map(|arg| arg.as_ptr()).collect();
    argv.push(std::ptr::null());

    let mut master_fd: libc::c_int = -1;
    let mut winsize = libc::winsize {
        ws_row: size.rows,
        ws_col: size.cols,
        ws_xpixel: size.pixel_width,
        ws_ypixel: size.pixel_height,
    };
    let pid = unsafe {
        libc::forkpty(
            &mut master_fd,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut winsize,
        )
    };
    if pid < 0 {
        return Err(format!("无法创建终端 PTY: {}", std::io::Error::last_os_error()));
    }
    if pid == 0 {
        unsafe {
            libc::chdir(cwd_c.as_ptr());
            libc::execve(exec_path_c.as_ptr(), argv.as_ptr(), envp.as_ptr());
            libc::perror(perror_label.as_ptr());
            libc::_exit(127);
        }
    }

    let reader_fd = unsafe { libc::dup(master_fd) };
    if reader_fd < 0 {
        unsafe {
            libc::close(master_fd);
            libc::kill(pid, libc::SIGTERM);
        }
        return Err(format!("无法复制终端 PTY fd: {}", std::io::Error::last_os_error()));
    }
    let resize_fd = unsafe { libc::dup(master_fd) };
    if resize_fd < 0 {
        unsafe {
            libc::close(reader_fd);
            libc::close(master_fd);
            libc::kill(pid, libc::SIGTERM);
        }
        return Err(format!("无法复制终端 resize fd: {}", std::io::Error::last_os_error()));
    }
    let reader = unsafe { File::from_raw_fd(reader_fd) };
    let writer = unsafe { File::from_raw_fd(master_fd) };
    let resize_handle = unsafe { File::from_raw_fd(resize_fd) };
    Ok((pid as u32, Box::new(reader), Box::new(writer), Some(resize_handle)))
}

#[cfg(not(unix))]
fn spawn_terminal_process(
    command: &str,
    args: &[String],
    cwd: &Path,
    session_id: &str,
    size: PtySize,
) -> Result<(u32, Box<dyn Read + Send>, Box<dyn Write + Send>, Option<File>), String> {
    let mut cmd = Command::new(command);
    cmd.args(args);
    cmd.current_dir(cwd);
    cmd.env("PI_GHOST_DAG_SESSION_ID", session_id);
    cmd.env("PATH", orchestrator_path_env(command));
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env("COLUMNS", size.cols.to_string());
    cmd.env("LINES", size.rows.to_string());
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|error| format!("无法启动终端 `{command}`: {error}"))?;
    let pid = child.id();
    let reader = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取终端 stdout".to_string())?;
    let writer = child
        .stdin
        .take()
        .ok_or_else(|| "无法写入终端 stdin".to_string())?;
    std::mem::forget(child);
    Ok((pid, Box::new(reader), Box::new(writer), None))
}

fn handle_orchestrator_ws(stream: &mut TcpStream, request: &Request, default_cwd: &str) -> Result<(), String> {
    let (cwd, session_id) = api_context(default_cwd, &request.query, &json!({}));
    let command = request
        .query
        .get("command")
        .map(String::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(default_orchestrator_command);
    let log_path = orchestrator_log_path(&cwd, &session_id);
    let size = pty_size_from_query(&request.query);

    write_websocket_handshake(stream, request)?;
    stream.set_read_timeout(None).ok();

    let ensure_body = json!({
        "force": false,
        "command": command,
        "cols": size.cols,
        "rows": size.rows,
        "pixel_width": size.pixel_width,
        "pixel_height": size.pixel_height
    });
    let start_data = match start_orchestrator(&cwd, &session_id, &ensure_body) {
        Ok(value) => value,
        Err(error) => {
            let _ = write_ws_frame(stream, 1, error.as_bytes());
            let _ = write_ws_frame(stream, 8, &[]);
            return Ok(());
        }
    };
    let _ = resize_orchestrator(&cwd, &session_id, &ensure_body);
    let (client_id, rx) = match add_orchestrator_client(&cwd, &session_id) {
        Ok(value) => value,
        Err(error) => {
            let _ = write_ws_frame(stream, 1, error.as_bytes());
            let _ = write_ws_frame(stream, 8, &[]);
            return Ok(());
        }
    };
    let tail = read_terminal_tail_text(&log_path, 262_144);
    if !tail.is_empty() {
        let _ = write_ws_frame(stream, 2, tail.as_bytes());
    } else if start_data.get("running").and_then(Value::as_bool).unwrap_or(false) {
        let _ = write_ws_frame(stream, 1, b"");
    }
    let mut output_stream = stream
        .try_clone()
        .map_err(|error| format!("无法克隆 WebSocket: {error}"))?;
    let reader_handle = thread::spawn(move || {
        for bytes in rx {
            if write_ws_frame(&mut output_stream, 2, &bytes).is_err() {
                break;
            }
        }
        let _ = output_stream.shutdown(Shutdown::Both);
    });

    loop {
        let frame = match read_ws_frame(stream) {
            Ok(frame) => frame,
            Err(_) => break,
        };
        match frame.opcode {
            0x1 => {
                let text = String::from_utf8_lossy(&frame.payload);
                let Ok(value) = serde_json::from_str::<Value>(&text) else {
                    let data = String::from_utf8_lossy(&frame.payload);
                    let _ = write_orchestrator_input(&cwd, &session_id, &data)?;
                    continue;
                };
                match value.get("type").and_then(Value::as_str).unwrap_or_default() {
                    "input" => {
                        let data = value.get("data").and_then(Value::as_str).unwrap_or_default();
                        let _ = write_orchestrator_input(&cwd, &session_id, data)?;
                    }
                    "resize" => {
                        let _ = resize_orchestrator(&cwd, &session_id, &value)?;
                    }
                    "stop" => {
                        break;
                    }
                    _ => {
                        let _ = write_orchestrator_input(&cwd, &session_id, &text)?;
                    }
                }
            }
            0x2 => {
                let data = String::from_utf8_lossy(&frame.payload);
                let _ = write_orchestrator_input(&cwd, &session_id, &data)?;
            }
            0x8 => break,
            0x9 => {
                let _ = write_ws_frame(stream, 0xA, &frame.payload);
            }
            0xA => {}
            _ => {}
        }
    }
    remove_orchestrator_client(&cwd, &session_id, &client_id);
    let _ = reader_handle.join();
    Ok(())
}

fn api_context(default_cwd: &str, query: &HashMap<String, String>, body: &Value) -> (String, String) {
    let cwd = body
        .get("cwd")
        .and_then(Value::as_str)
        .or_else(|| query.get("cwd").map(String::as_str))
        .unwrap_or(default_cwd)
        .to_string();
    let session = body
        .get("session_id")
        .or_else(|| body.get("sessionId"))
        .and_then(Value::as_str)
        .or_else(|| query.get("session_id").map(String::as_str))
        .or_else(|| query.get("sessionId").map(String::as_str))
        .unwrap_or("default")
        .to_string();
    (cwd, session)
}

fn handle_api(request: &Request, default_cwd: &str) -> Result<Value, String> {
    if request.method == "GET" && request.path == "/api/state" {
        let (cwd, session_id) = api_context(default_cwd, &request.query, &json!({}));
        return get_snapshot(&cwd, &session_id).map(|data| json!({ "ok": true, "data": data }));
    }
    if request.method == "GET" && request.path == "/api/orchestrator/status" {
        let (cwd, session_id) = api_context(default_cwd, &request.query, &json!({}));
        return orchestrator_status(&cwd, &session_id).map(|data| json!({ "ok": true, "data": data }));
    }
    if request.method == "GET" && request.path == "/api/orchestrator/logs" {
        let (cwd, session_id) = api_context(default_cwd, &request.query, &json!({}));
        return orchestrator_status(&cwd, &session_id).map(|data| json!({ "ok": true, "data": data }));
    }
    if request.method != "POST" {
        return Ok(json!({ "ok": false, "error": "Method not allowed", "status": 405 }));
    }
    let body: Value = if request.body.is_empty() {
        json!({})
    } else {
        serde_json::from_slice(&request.body).map_err(|error| format!("请求 JSON 无效: {error}"))?
    };
    let (cwd, session_id) = api_context(default_cwd, &request.query, &body);
    let data = match request.path.as_str() {
        "/api/run-next" => run_next(&cwd, &session_id)?,
        "/api/run-until-blocked" => {
            run_until_blocked(&cwd, body.get("limit").and_then(Value::as_u64).unwrap_or(50), &session_id)?
        }
        "/api/approve" => approve_node(&cwd, body.get("id").and_then(Value::as_str).unwrap_or_default(), &session_id)?,
        "/api/resolve" => resolve_task(
            &cwd,
            body.get("id").and_then(Value::as_str).unwrap_or_default(),
            body.get("answer").and_then(Value::as_str).unwrap_or_default(),
            &session_id,
        )?,
        "/api/rerun" => rerun_task(&cwd, body.get("id").and_then(Value::as_str).unwrap_or_default(), &session_id)?,
        "/api/orchestrator/start" => start_orchestrator(&cwd, &session_id, &body)?,
        "/api/orchestrator/send" => send_orchestrator(
            &cwd,
            &session_id,
            body.get("message").and_then(Value::as_str).unwrap_or_default(),
        )?,
        "/api/orchestrator/input" => write_orchestrator_input(
            &cwd,
            &session_id,
            body.get("data").and_then(Value::as_str).unwrap_or_default(),
        )?,
        "/api/orchestrator/resize" => resize_orchestrator(&cwd, &session_id, &body)?,
        "/api/orchestrator/stop" => stop_orchestrator(&cwd, &session_id)?,
        _ => return Ok(json!({ "ok": false, "error": "API route not found", "status": 404 })),
    };
    Ok(json!({ "ok": true, "data": data }))
}

fn mime_type(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()).unwrap_or_default() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        _ => "application/octet-stream",
    }
}

fn dashboard_dir() -> Result<PathBuf, String> {
    let path = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../src")
    } else {
        let exe = env::current_exe().map_err(|error| format!("无法读取 server 路径: {error}"))?;
        let resources = exe
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| format!("无法解析 app Resources 目录: {}", exe.display()))?;
        resources.join("dashboard")
    };
    if path.join("index.html").is_file() {
        Ok(path)
    } else {
        Err(format!("dashboard 缺失: {}", path.display()))
    }
}

fn safe_static_path(dashboard: &Path, request_path: &str) -> Option<PathBuf> {
    let relative = if request_path == "/" {
        "index.html"
    } else {
        request_path.trim_start_matches('/')
    };
    let mut path = PathBuf::from(dashboard);
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(part) => path.push(part),
            _ => return None,
        }
    }
    Some(path)
}

fn handle_request(mut stream: TcpStream, default_cwd: String, dashboard: PathBuf) {
    let result = (|| -> Result<(), String> {
        let request = read_request(&mut stream)?;
        if request.method == "OPTIONS" {
            return write_response(&mut stream, 204, "text/plain; charset=utf-8", b"");
        }
        if request.method == "GET" && request.path == "/api/orchestrator/ws" {
            return handle_orchestrator_ws(&mut stream, &request, &default_cwd);
        }
        if request.path.starts_with("/api/") {
            let status = if request.method == "POST"
                || request.path == "/api/state"
                || request.path == "/api/orchestrator/status"
                || request.path == "/api/orchestrator/logs"
            {
                200
            } else {
                405
            };
            let payload = handle_api(&request, &default_cwd)?;
            let status = payload
                .get("status")
                .and_then(Value::as_u64)
                .map(|value| value as u16)
                .unwrap_or(status);
            return send_json(&mut stream, status, payload);
        }
        let Some(file_path) = safe_static_path(&dashboard, &request.path) else {
            return write_response(&mut stream, 403, "text/plain; charset=utf-8", b"Forbidden");
        };
        if !file_path.is_file() {
            return write_response(&mut stream, 404, "text/plain; charset=utf-8", b"Not found");
        }
        let body = fs::read(&file_path)
            .map_err(|error| format!("无法读取静态文件 {}: {error}", file_path.display()))?;
        write_response(&mut stream, 200, mime_type(&file_path), &body)
    })();
    if let Err(error) = result {
        let _ = send_json(&mut stream, 500, json!({ "ok": false, "error": error }));
    }
}

fn parse_args() -> Result<(String, String, u16), String> {
    let mut cwd = env::current_dir()
        .unwrap_or_else(|_| env::temp_dir())
        .to_string_lossy()
        .into_owned();
    let mut host = "127.0.0.1".to_string();
    let mut port = 7331_u16;
    let mut args = env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--cwd" => cwd = args.next().ok_or_else(|| "--cwd 缺少参数".to_string())?,
            "--host" => host = args.next().ok_or_else(|| "--host 缺少参数".to_string())?,
            "--port" => {
                port = args
                    .next()
                    .ok_or_else(|| "--port 缺少参数".to_string())?
                    .parse::<u16>()
                    .map_err(|error| format!("--port 无效: {error}"))?
            }
            value if !value.starts_with('-') => cwd = value.to_string(),
            value => return Err(format!("Unknown argument: {value}")),
        }
    }
    Ok((cwd, host, port))
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let (cwd, host, port) = parse_args()?;
    let dashboard = dashboard_dir()?;
    let listener = TcpListener::bind((host.as_str(), port))
        .map_err(|error| format!("无法监听 {host}:{port}: {error}"))?;
    let addr = listener
        .local_addr()
        .map_err(|error| format!("无法读取监听地址: {error}"))?;
    println!("pi-ghost-dag: http://{addr}/");
    println!("cwd: {}", PathBuf::from(&cwd).display());
    println!("dashboard: {}", dashboard.display());
    for stream in listener.incoming() {
        match stream {
            Ok(stream) => {
                let cwd = cwd.clone();
                let dashboard = dashboard.clone();
                thread::spawn(move || handle_request(stream, cwd, dashboard));
            }
            Err(error) => eprintln!("connection error: {error}"),
        }
    }
    Ok(())
}

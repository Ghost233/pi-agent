#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    io::Write,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

#[derive(Default)]
struct AppState {
    active: Mutex<Option<ServiceRecord>>,
}

#[derive(Debug, Deserialize)]
struct StartRequest {
    cwd: Option<String>,
    port: Option<u16>,
    server_script: Option<String>,
    orchestrator_command: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ServiceRecord {
    pid: u32,
    cwd: String,
    port: u16,
    server_script: String,
    #[serde(default)]
    orchestrator_command: Option<String>,
    url: String,
    log_path: String,
    started_at: String,
}

#[derive(Serialize)]
struct ServiceStatus {
    running: bool,
    pid: Option<u32>,
    cwd: Option<String>,
    port: Option<u16>,
    server_script: Option<String>,
    orchestrator_command: Option<String>,
    url: Option<String>,
    log_path: Option<String>,
}

fn candidate_server_binary_paths() -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if let Ok(value) = env::var("PI_GHOST_DAG_SERVER") {
        paths.push(PathBuf::from(value));
    }
    if let Ok(exe) = env::current_exe() {
        if cfg!(target_os = "macos") {
            if let Some(contents) = exe.parent().and_then(Path::parent) {
                paths.push(contents.join("Resources/bin/pi-ghost-dag-server"));
            }
        } else if let Some(parent) = exe.parent() {
            paths.push(parent.join("bin/pi-ghost-dag-server"));
            paths.push(parent.join("pi-ghost-dag-server"));
        }
        if let Some(parent) = exe.parent() {
            paths.push(parent.join("pi-ghost-dag-server"));
        }
    }
    if let Ok(current) = env::current_dir() {
        for ancestor in current.ancestors().take(8) {
            paths.push(
                ancestor
                    .join("apps/pi-ghost-dag-launcher/src-tauri/target/release/pi-ghost-dag-server"),
            );
            paths.push(
                ancestor
                    .join("apps/pi-ghost-dag-launcher/src-tauri/target/debug/pi-ghost-dag-server"),
            );
            paths.push(ancestor.join("target/release/pi-ghost-dag-server"));
            paths.push(ancestor.join("target/debug/pi-ghost-dag-server"));
        }
    }
    paths
}

fn default_server_binary() -> String {
    candidate_server_binary_paths()
        .into_iter()
        .find(|path| path.is_file())
        .unwrap_or_else(|| PathBuf::from("pi-ghost-dag-server"))
        .to_string_lossy()
        .into_owned()
}

fn normalize_server_binary(input: Option<String>) -> String {
    input
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(default_server_binary)
}

fn global_service_dir() -> PathBuf {
    if let Ok(value) = env::var("PI_GHOST_DAG_SERVICE_DIR") {
        return PathBuf::from(value);
    }
    if let Ok(home) = env::var("HOME") {
        return PathBuf::from(home).join(".pi-ghost-dag");
    }
    env::temp_dir().join("pi-ghost-dag")
}

fn service_record_path() -> PathBuf {
    global_service_dir().join("service.json")
}

fn service_log_path() -> PathBuf {
    global_service_dir().join("service.log")
}

fn now_stamp() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    format!("unix:{seconds}")
}

fn status_from_record(record: &ServiceRecord) -> ServiceStatus {
    ServiceStatus {
        running: true,
        pid: Some(record.pid),
        cwd: Some(record.cwd.clone()),
        port: Some(record.port),
        server_script: Some(record.server_script.clone()),
        orchestrator_command: record.orchestrator_command.clone(),
        url: Some(record.url.clone()),
        log_path: Some(record.log_path.clone()),
    }
}

fn stopped_status_for(
    cwd: Option<String>,
    port: Option<u16>,
    server_script: Option<String>,
    log_path: Option<String>,
) -> ServiceStatus {
    ServiceStatus {
        running: false,
        pid: None,
        cwd,
        port,
        server_script: Some(server_script.unwrap_or_else(default_server_binary)),
        orchestrator_command: None,
        url: None,
        log_path,
    }
}

fn normalize_optional_command(input: Option<String>) -> Option<String> {
    input
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn ensure_service_dir() -> Result<(), String> {
    fs::create_dir_all(global_service_dir()).map_err(|error| format!("无法创建服务目录: {error}"))
}

fn append_log(path: &Path, line: impl AsRef<str>) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "{}", line.as_ref());
    }
}

fn read_last_lines(path: &Path, limit: usize) -> Vec<String> {
    let Ok(text) = fs::read_to_string(path) else {
        return Vec::new();
    };
    let mut lines: Vec<String> = text
        .lines()
        .rev()
        .take(limit)
        .map(ToString::to_string)
        .collect();
    lines.reverse();
    lines
}

fn write_service_record(record: &ServiceRecord) -> Result<(), String> {
    ensure_service_dir()?;
    let body = serde_json::to_string_pretty(record)
        .map_err(|error| format!("无法序列化服务状态: {error}"))?;
    fs::write(service_record_path(), format!("{body}\n"))
        .map_err(|error| format!("无法写入服务状态: {error}"))
}

fn read_service_record() -> Option<ServiceRecord> {
    let text = fs::read_to_string(service_record_path()).ok()?;
    serde_json::from_str(&text).ok()
}

fn remove_service_record() {
    let _ = fs::remove_file(service_record_path());
}

fn ensure_port_available(port: u16) -> Result<(), String> {
    if port == 0 {
        return Ok(());
    }
    match TcpListener::bind(("127.0.0.1", port)) {
        Ok(listener) => {
            drop(listener);
            Ok(())
        }
        Err(error) => Err(format!(
            "端口 {port} 不可用: {error}。不会自动改用其他端口；请停止占用进程后重试，或使用强制停止。"
        )),
    }
}

#[cfg(unix)]
fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(unix)]
fn pid_is_alive(pid: u32) -> bool {
    Command::new("kill")
        .arg("-0")
        .arg(pid.to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(windows)]
fn pid_is_alive(pid: u32) -> bool {
    Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}")])
        .output()
        .map(|output| String::from_utf8_lossy(&output.stdout).contains(&pid.to_string()))
        .unwrap_or(false)
}

#[cfg(unix)]
fn record_is_alive(record: &ServiceRecord) -> bool {
    if !pid_is_alive(record.pid) {
        return false;
    }
    let Ok(output) = Command::new("ps")
        .args(["-ww", "-p", &record.pid.to_string(), "-o", "command="])
        .output()
    else {
        return true;
    };
    if !output.status.success() {
        return true;
    }
    let command = String::from_utf8_lossy(&output.stdout);
    command.contains(&record.server_script)
}

#[cfg(windows)]
fn record_is_alive(record: &ServiceRecord) -> bool {
    pid_is_alive(record.pid)
}

#[cfg(unix)]
fn kill_pid(pid: u32) -> Result<(), String> {
    let status = Command::new("kill")
        .arg(pid.to_string())
        .status()
        .map_err(|error| format!("停止失败: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("停止失败: kill 返回 {status}"))
    }
}

#[cfg(windows)]
fn kill_pid(pid: u32) -> Result<(), String> {
    let status = Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .status()
        .map_err(|error| format!("停止失败: {error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("停止失败: taskkill 返回 {status}"))
    }
}

#[cfg(unix)]
fn spawn_detached_server(
    server_binary: &str,
    cwd: &str,
    port: u16,
    log_path: &Path,
    orchestrator_command: Option<&str>,
) -> Result<u32, String> {
    let env_prefix = orchestrator_command
        .map(|command| {
            format!(
                "PI_GHOST_ORCHESTRATOR_COMMAND={} PI_GHOST_DAG_ORCHESTRATOR={} ",
                shell_quote(command),
                shell_quote(command)
            )
        })
        .unwrap_or_default();
    let command = format!(
        "{}nohup {} --cwd {} --host 127.0.0.1 --port {} >> {} 2>&1 < /dev/null & echo $!",
        env_prefix,
        shell_quote(server_binary),
        shell_quote(cwd),
        port,
        shell_quote(&log_path.to_string_lossy())
    );
    let output = Command::new("/bin/sh")
        .arg("-c")
        .arg(command)
        .output()
        .map_err(|error| format!("启动失败: {error}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if stderr.is_empty() {
            format!("启动失败: {}", output.status)
        } else {
            format!("启动失败: {stderr}")
        });
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout
        .lines()
        .next()
        .unwrap_or_default()
        .trim()
        .parse::<u32>()
        .map_err(|error| format!("无法读取后台服务 PID: {error}"))
}

#[cfg(windows)]
fn spawn_detached_server(
    server_binary: &str,
    cwd: &str,
    port: u16,
    log_path: &Path,
    orchestrator_command: Option<&str>,
) -> Result<u32, String> {
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)
        .map_err(|error| format!("无法打开日志文件: {error}"))?;
    let err = log
        .try_clone()
        .map_err(|error| format!("无法复制日志文件: {error}"))?;
    let mut command = Command::new(server_binary);
    command
        .arg("--cwd")
        .arg(cwd)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(err));
    if let Some(orchestrator_command) = orchestrator_command {
        command.env("PI_GHOST_ORCHESTRATOR_COMMAND", orchestrator_command);
        command.env("PI_GHOST_DAG_ORCHESTRATOR", orchestrator_command);
    }
    let child = command.spawn().map_err(|error| format!("启动失败: {error}"))?;
    Ok(child.id())
}

fn recover_record() -> Option<ServiceRecord> {
    let record = read_service_record()?;
    if record_is_alive(&record) {
        return Some(record);
    }
    append_log(
        &service_log_path(),
        format!(
            "launcher: stale service record removed for pid {}",
            record.pid
        ),
    );
    remove_service_record();
    None
}

fn default_service_cwd(input: Option<String>) -> String {
    let requested = input
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .filter(|value| Path::new(value).is_dir());
    if let Some(cwd) = requested {
        return cwd;
    }
    if let Ok(home) = env::var("HOME") {
        return home;
    }
    env::current_dir()
        .unwrap_or_else(|_| env::temp_dir())
        .to_string_lossy()
        .into_owned()
}

#[tauri::command]
fn start_service(
    state: tauri::State<'_, AppState>,
    request: StartRequest,
) -> Result<ServiceStatus, String> {
    ensure_service_dir()?;

    let port = request.port.unwrap_or(7331);
    if let Some(record) = recover_record() {
        if record.port != port {
            return Err(format!(
                "后台服务已经在端口 {} 运行，不能自动改用端口 {port}。请先停止服务，或使用强制停止。",
                record.port
            ));
        }
        *state.active.lock().map_err(|_| "service lock poisoned")? = Some(record.clone());
        return Ok(status_from_record(&record));
    }

    let server_script = normalize_server_binary(request.server_script);
    let orchestrator_command = normalize_optional_command(request.orchestrator_command);
    if !Path::new(&server_script).is_file() {
        return Err(format!("Server 二进制不存在: {server_script}"));
    }
    ensure_port_available(port)?;
    let cwd = default_service_cwd(request.cwd);

    let log_path = service_log_path();
    append_log(&log_path, format!("launcher: server {server_script}"));
    append_log(&log_path, format!("launcher: service cwd {cwd}"));
    if let Some(command) = &orchestrator_command {
        append_log(&log_path, format!("launcher: orchestrator command {command}"));
    }
    append_log(&log_path, "launcher: service is detached from Tauri app");

    let pid = spawn_detached_server(
        &server_script,
        &cwd,
        port,
        &log_path,
        orchestrator_command.as_deref(),
    )?;
    let record = ServiceRecord {
        pid,
        cwd,
        port,
        server_script,
        orchestrator_command,
        url: format!("http://127.0.0.1:{port}/"),
        log_path: log_path.to_string_lossy().into_owned(),
        started_at: now_stamp(),
    };

    thread::sleep(Duration::from_millis(350));
    if !record_is_alive(&record) {
        let detail = read_last_lines(&log_path, 20).join("\n");
        return Err(format!("后台服务启动后立即退出:\n{detail}"));
    }

    write_service_record(&record)?;
    append_log(&log_path, format!("launcher: started pid {}", record.pid));
    *state.active.lock().map_err(|_| "service lock poisoned")? = Some(record.clone());
    Ok(status_from_record(&record))
}

#[tauri::command]
fn stop_workspace(state: tauri::State<'_, AppState>, cwd: String) -> Result<ServiceStatus, String> {
    let _ = cwd;
    stop_service(state)
}

#[tauri::command]
fn stop_service(state: tauri::State<'_, AppState>) -> Result<ServiceStatus, String> {
    let record = state
        .active
        .lock()
        .map_err(|_| "service lock poisoned")?
        .clone();
    let record = record.or_else(read_service_record);
    let log_path = service_log_path();
    if let Some(record) = record {
        append_log(&log_path, format!("launcher: stopping pid {}", record.pid));
        if record_is_alive(&record) {
            kill_pid(record.pid)?;
            thread::sleep(Duration::from_millis(200));
        }
        remove_service_record();
        append_log(&log_path, "launcher: stopped");
        *state.active.lock().map_err(|_| "service lock poisoned")? = None;
    }
    Ok(stopped_status_for(
        None,
        None,
        None,
        Some(log_path.to_string_lossy().into_owned()),
    ))
}

#[tauri::command]
fn force_stop_service(state: tauri::State<'_, AppState>) -> Result<ServiceStatus, String> {
    let record = state
        .active
        .lock()
        .map_err(|_| "service lock poisoned")?
        .clone()
        .or_else(read_service_record);
    let log_path = service_log_path();
    if let Some(record) = record {
        append_log(&log_path, format!("launcher: force stopping pid {}", record.pid));
        if pid_is_alive(record.pid) {
            kill_pid(record.pid)?;
            thread::sleep(Duration::from_millis(250));
        }
        remove_service_record();
        append_log(&log_path, "launcher: force stopped");
        *state.active.lock().map_err(|_| "service lock poisoned")? = None;
    }
    Ok(stopped_status_for(
        None,
        None,
        None,
        Some(log_path.to_string_lossy().into_owned()),
    ))
}

#[tauri::command]
fn status_for_workspace(
    state: tauri::State<'_, AppState>,
    cwd: String,
) -> Result<ServiceStatus, String> {
    let _ = cwd;
    let log_path = service_log_path().to_string_lossy().into_owned();
    if let Some(record) = recover_record() {
        *state.active.lock().map_err(|_| "service lock poisoned")? = Some(record.clone());
        return Ok(status_from_record(&record));
    }
    Ok(stopped_status_for(None, None, None, Some(log_path)))
}

#[tauri::command]
fn status(state: tauri::State<'_, AppState>) -> Result<ServiceStatus, String> {
    let mut guard = state.active.lock().map_err(|_| "service lock poisoned")?;
    if let Some(record) = guard.clone() {
        if record_is_alive(&record) {
            return Ok(status_from_record(&record));
        }
        remove_service_record();
        *guard = None;
    }
    if let Some(record) = recover_record() {
        *guard = Some(record.clone());
        return Ok(status_from_record(&record));
    }
    Ok(stopped_status_for(None, None, None, None))
}

#[tauri::command]
fn logs_for_workspace(cwd: String) -> Result<Vec<String>, String> {
    let _ = cwd;
    Ok(read_last_lines(&service_log_path(), 600))
}

#[tauri::command]
fn logs(state: tauri::State<'_, AppState>) -> Result<Vec<String>, String> {
    let _ = state;
    Ok(read_last_lines(&service_log_path(), 600))
}

#[tauri::command]
fn clear_logs_for_workspace(cwd: String) -> Result<(), String> {
    let _ = cwd;
    clear_logs()
}

#[tauri::command]
fn clear_logs() -> Result<(), String> {
    ensure_service_dir()?;
    fs::write(service_log_path(), "").map_err(|error| format!("无法清空日志: {error}"))
}

fn open_url(url: &str) -> Result<(), String> {
    let mut command = if cfg!(target_os = "macos") {
        let mut cmd = Command::new("open");
        cmd.arg(url);
        cmd
    } else if cfg!(target_os = "windows") {
        let mut cmd = Command::new("cmd");
        cmd.args(["/C", "start", "", url]);
        cmd
    } else {
        let mut cmd = Command::new("xdg-open");
        cmd.arg(url);
        cmd
    };
    command
        .spawn()
        .map_err(|error| format!("无法打开浏览器: {error}"))?;
    Ok(())
}

#[cfg(target_os = "macos")]
fn choose_folder_with_prompt(prompt: &str) -> Result<Option<String>, String> {
    let script = format!(
        "POSIX path of (choose folder with prompt {})",
        serde_json::to_string(prompt).map_err(|error| format!("无法构造选择器脚本: {error}"))?
    );
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|error| format!("无法打开文件夹选择器: {error}"))?;
    if output.status.success() {
        let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok((!value.is_empty()).then_some(value));
    }
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();
    if stderr.contains("User canceled") || stderr.contains("-128") {
        return Ok(None);
    }
    Err(format!("文件夹选择器失败: {}", stderr.trim()))
}

#[cfg(not(target_os = "macos"))]
fn choose_folder_with_prompt(_prompt: &str) -> Result<Option<String>, String> {
    Err("当前平台暂未实现原生文件夹选择器，请拖入目录或手动配置。".to_string())
}

#[tauri::command]
fn choose_existing_folder() -> Result<Option<String>, String> {
    choose_folder_with_prompt("选择要作为 Pi Ghost DAG 项目的现有文件夹")
}

#[tauri::command]
fn choose_empty_project_folder() -> Result<Option<String>, String> {
    choose_folder_with_prompt("选择一个空白项目文件夹，或在对话框中新建文件夹")
}

fn url_component(value: &str) -> String {
    let mut output = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                output.push(byte as char)
            }
            _ => output.push_str(&format!("%{byte:02X}")),
        }
    }
    output
}

fn home_dir_candidates() -> Vec<PathBuf> {
    let mut homes = Vec::new();
    for key in ["HOME", "USERPROFILE"] {
        if let Ok(value) = env::var(key) {
            let path = PathBuf::from(value);
            if path.is_dir() && !homes.contains(&path) {
                homes.push(path);
            }
        }
    }
    for key in ["USER", "LOGNAME"] {
        if let Ok(value) = env::var(key) {
            let path = PathBuf::from("/Users").join(value);
            if path.is_dir() && !homes.contains(&path) {
                homes.push(path);
            }
        }
    }
    homes
}

fn default_orchestrator_command() -> String {
    if let Ok(value) = env::var("PI_GHOST_DAG_ORCHESTRATOR") {
        let command = value.trim().to_string();
        if !command.is_empty() {
            return command;
        }
    }
    for home in home_dir_candidates() {
        let candidate = home.join(".local/bin/pi-ghost");
        if candidate.is_file() {
            return candidate.to_string_lossy().into_owned();
        }
    }
    "pi-ghost".to_string()
}

fn orchestrator_path_env() -> String {
    let mut paths = Vec::new();
    for home in home_dir_candidates() {
        for relative in [".local/bin", ".cargo/bin"] {
            let path = home.join(relative);
            if path.is_dir() {
                paths.push(path);
            }
        }
        let fnm_dir = home.join(".local/state/fnm_multishells");
        if let Ok(entries) = fs::read_dir(fnm_dir) {
            for entry in entries.flatten() {
                let path = entry.path().join("bin");
                if path.is_dir() {
                    paths.push(path);
                }
            }
        }
    }
    if let Ok(existing) = env::var("PATH") {
        paths.extend(env::split_paths(&existing));
    }
    env::join_paths(paths)
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|_| env::var("PATH").unwrap_or_default())
}

#[cfg(target_os = "macos")]
fn open_terminal_command(command: &str) -> Result<(), String> {
    let script = format!(
        "tell application \"Terminal\"\nactivate\ndo script {}\nend tell",
        serde_json::to_string(command).map_err(|error| format!("无法构造终端脚本: {error}"))?
    );
    let output = Command::new("osascript")
        .arg("-e")
        .arg(script)
        .output()
        .map_err(|error| format!("无法打开终端: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    Err(format!(
        "打开终端失败: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

#[cfg(not(target_os = "macos"))]
fn open_terminal_command(_command: &str) -> Result<(), String> {
    Err("当前平台暂未实现打开系统终端。".to_string())
}

#[tauri::command]
fn open_orchestrator_terminal(cwd: String, session_id: Option<String>) -> Result<(), String> {
    let workspace = PathBuf::from(cwd)
        .canonicalize()
        .map_err(|error| format!("工作区路径无效: {error}"))?;
    let session = session_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "default".to_string());
    let command = default_orchestrator_command();
    let shell_command = format!(
        "cd {} && export PATH={} && export PI_GHOST_DAG_SESSION_ID={} && exec {}",
        shell_quote(&workspace.to_string_lossy()),
        shell_quote(&orchestrator_path_env()),
        shell_quote(&session),
        shell_quote(&command),
    );
    open_terminal_command(&shell_command)
}

#[tauri::command]
fn open_dashboard_for_workspace(
    state: tauri::State<'_, AppState>,
    cwd: String,
    session_id: Option<String>,
) -> Result<(), String> {
    let status = status_for_workspace(state, cwd.clone())?;
    let url = status.url.ok_or_else(|| "服务未启动".to_string())?;
    let session = session_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| "default".to_string());
    open_url(&format!(
        "{}?cwd={}&session_id={}",
        url,
        url_component(&cwd),
        url_component(&session)
    ))
}

#[tauri::command]
fn open_dashboard(state: tauri::State<'_, AppState>) -> Result<(), String> {
    let status = status(state)?;
    let url = status.url.ok_or_else(|| "服务未启动".to_string())?;
    open_url(&url)
}

#[tauri::command]
fn restart_ui(app: tauri::AppHandle) -> Result<(), String> {
    app.request_restart();
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            start_service,
            stop_service,
            force_stop_service,
            stop_workspace,
            status,
            status_for_workspace,
            logs,
            logs_for_workspace,
            clear_logs,
            clear_logs_for_workspace,
            choose_existing_folder,
            choose_empty_project_folder,
            open_dashboard,
            open_dashboard_for_workspace,
            open_orchestrator_terminal,
            restart_ui
        ])
        .run(tauri::generate_context!())
        .expect("error while running Tauri app");
}

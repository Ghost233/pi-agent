# pi-agent

Pi SDK agent 的个人配置还原仓库。

## 安装

从 GitHub 一键安装：

```bash
curl -fsSL https://raw.githubusercontent.com/Ghost233/pi-agent/main/scripts/install.sh | bash
```

脚本不会假设当前电脑已经安装 `pi`。完整安装时会先通过 npm 安装或更新官方 Pi CLI：

```bash
npm install -g @earendil-works/pi-coding-agent
```

默认会创建独立 Pi 环境：

- 配置目录：`~/.pi/agent-pi-ghost`
- profile 备份：`~/.pi/agent-pi-ghost/profile.toml`
- 启动命令：`~/.local/bin/pi-ghost`
- DAG 平台启动命令：`~/.local/bin/pi-ghost-dag`

安装完成后使用：

```bash
pi-ghost
```

这等价于：

```bash
PI_CODING_AGENT_DIR="$HOME/.pi/agent-pi-ghost" pi
```

普通 `pi` 仍然读取默认的 `~/.pi/agent`，不会和 `pi-ghost` 混在一起。

如果要启动本地可视化 DAG 平台：

```bash
pi-ghost-dag /Users/ghost/code/api-doc
```

`pi-ghost-dag` 会启动本地 Dashboard，默认地址是：

```text
http://127.0.0.1:7331/
```

这个平台的服务进程是全局后台服务，不绑定某一个工作区。Tauri 启动器使用内置 Rust server binary，不依赖本机 Node.js。服务状态保存在：

- `~/.pi-ghost-dag/service.json`：后台 Dashboard 服务的 PID、端口和 server binary 路径
- `~/.pi-ghost-dag/service.log`：后台 Dashboard 服务日志

每个工作区的 DAG 数据仍然保存在目标项目里的 `.pi-flow/`：

- `dag.json`：阶段 DAG
- `tasks.ndjson`：循环任务参数表，一行一个 task
- `state.json`：当前状态
- `sessions/<session-id>/`：工作区里的独立会话，类似 Codex thread，每个会话有自己的 DAG、任务和运行状态
- `runs/`：节点或 task 的运行结果、日志和 diff

UI 是 DAG 平台的主入口。脚本只作为内部 runtime 使用，不要求日常手动操作。

如果想用桌面控制台管理这个本地服务，可以使用 Tauri 启动器源码：

```bash
cd apps/pi-ghost-dag-launcher
npm install
npm run dev
```

这个启动器负责：

- 左侧管理工作区列表
- 左侧按工作区分组展示会话，类似 Codex 的 project/thread 层级，DAG 控制台跟随当前会话切换
- 项目标题右侧可以添加项目：选择“新建空白项目”或“使用现有文件夹”，也可以把目录直接拖进左侧项目区
- 启动 / 停止全局 `pi-ghost-dag` 后台服务
- 关闭 Tauri 后不停止后台服务，下次打开会通过 `~/.pi-ghost-dag/service.json` 找回正在运行的服务
- 在 Tauri 内查看当前 DAG 图、节点运行情况和 task 状态
- 底部按 tab 查看结构化编排者、原始终端、服务日志、节点运行记录和事件
- 用系统浏览器打开完整 Dashboard

浏览器 Dashboard 仍然保留，用于完整 DAG 操作；Tauri 侧强化为本地控制台，不再只是日志启动器。只有在 Tauri 里点击“停止”，才会结束对应工作区的后台服务。

Tauri 启动器默认会从 app 包内启动 `Contents/Resources/bin/pi-ghost-dag-server`。开发模式下会自动使用 `apps/pi-ghost-dag-launcher/src-tauri/target/release/pi-ghost-dag-server`。

当前配置会自动安装 Pi Extension：

- `npm:pi-subagents`
- `npm:pi-rtk-optimizer`
- `npm:@juicesharp/rpiv-todo`
- `npm:pi-codex-goal`
- `npm:@juicesharp/rpiv-ask-user-question`
- `npm:@juicesharp/rpiv-btw`
- `npm:@firstpick/pi-extension-safety-guard`
- `npm:pi-code-previews`
- `npm:pi-bar`
- `npm:@pi-unipi/compactor`

同时会同步个人 Pi DAG Agent 和本地 DAG Runtime：

- Runtime：`pi-ghost-dag`
- 通用 DAG Agent：`dag-planner` / `dag-runner` / `dag-worker` / `dag-reviewer`

`pi-ghost-dag` 作为 Runtime 下发到 `~/.pi/agent-pi-ghost/runtimes/pi-ghost-dag/`。项目里的 `.pi-flow/` 只保存运行数据，例如 `dag.json`、`tasks.ndjson`、`state.json`、`sessions/` 和 `runs/`。

这个仓库只管理 Pi 自己的配置，不写入其他工具的全局配置。

同时会下发 `pi-ghost` 的系统追加提示词：

- 源文件：`configs/pi-ghost/APPEND_SYSTEM.md`
- 目标文件：`~/.pi/agent-pi-ghost/APPEND_SYSTEM.md`
- 作用：要求 `pi-ghost` 默认使用简体中文沟通；只影响 `pi-ghost` 隔离环境，不影响普通 `pi`

同时会下发 UniPi compactor 配置：

- 源文件：`configs/unipi/compactor/config.json`
- 目标文件：`~/.unipi/config/compactor/config.json`
- 自动压缩阈值：上下文占用达到 75%
- 说明：`@pi-unipi/compactor` 当前读取固定的 `~/.unipi/config/compactor/config.json`，所以安装脚本会把仓库配置同步到这个位置。

`pi-ghost-dag` 的固定分层：

- `pi-ghost`：标准 Pi agent 入口，保持终端使用方式不变
- `pi-ghost-dag`：本地 DAG 可视化平台入口
- Dashboard：创建计划、审批、运行、暂停、处理 blocker、查看结果
- DAG 图：从全局视角查看阶段依赖，点击节点可高亮上下游并查看节点详情
- Runtime：读写目标项目 `.pi-flow/`
- Worker：每次只处理一个外置 task 参数

大量重复任务不要展开成几百个 DAG 节点。DAG 只表达阶段，例如：

```text
build-groups -> review-groups -> map(fix-one) -> summarize-result
```

具体的 200 组文件任务写入 `tasks.ndjson`，由 `map` 节点逐个领取执行。

从本地仓库安装：

```bash
./scripts/install.sh
```

脚本可以反复运行：

- 官方 Pi CLI 会先通过 `npm install -g` 安装或更新
- profile 内容没变时不会覆盖，也不会产生备份
- `pi-ghost` 启动脚本内容没变时不会重写
- `pi-ghost-dag` 启动脚本内容没变时不会重写
- profile 明确废弃的 Extension 会被移除
- Agent 和 Runtime 文件内容没变时不会重写
- profile 明确废弃的旧 Skill、Flow 文件会被移除
- UniPi compactor 配置内容没变时不会重写
- 已安装的 Extension 不会重复 `pi install`
- 已安装过 Extension 时会执行一次 `pi update --extensions`

预览将要执行的操作：

```bash
./scripts/install.sh --dry-run
```

只还原配置文件，不安装 Extension：

```bash
./scripts/install.sh --config-only
```

不自动安装 Pi CLI：

```bash
./scripts/install.sh --no-pi-install
```

只检查并安装缺失 Extension，不做更新：

```bash
./scripts/install.sh --no-update
```

强制重新安装 profile 里声明的 Extension：

```bash
./scripts/install.sh --force
```

如果 `~/.local/bin` 不在 `PATH` 里，可以先用完整路径启动：

```bash
~/.local/bin/pi-ghost
```

自定义独立环境目录：

```bash
./scripts/install.sh --agent-dir ~/.pi/agent-pi-ghost
```

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

安装完成后使用：

```bash
pi-ghost
```

这等价于：

```bash
PI_CODING_AGENT_DIR="$HOME/.pi/agent-pi-ghost" pi
```

普通 `pi` 仍然读取默认的 `~/.pi/agent`，不会和 `pi-ghost` 混在一起。

当前配置会自动安装 Pi Extension：

- `npm:pi-agent-flow`
- `npm:pi-rtk-optimizer`
- `npm:@juicesharp/rpiv-todo`
- `npm:pi-codex-goal`
- `npm:@juicesharp/rpiv-ask-user-question`
- `npm:@juicesharp/rpiv-btw`
- `npm:@firstpick/pi-extension-safety-guard`
- `npm:pi-code-previews`
- `npm:pi-context-usage`

同时会同步个人 Skill 和 Flow：

- Skill：`api-doc-flow`
- Planner Flow：`api-doc-plan-dag`
- Runner Flow：`api-doc-run-next`
- Worker Flow：`api-doc-fix-one`

`api-doc-flow` 的 `task-store.mjs` 随 Skill 下发到 `~/.pi/agent-pi-ghost/skills/api-doc-flow/scripts/`，项目里的 `.pi-flow/` 只保存运行数据，例如 `dag.json`、`groups.json`、`groups.ndjson` 和 `state.json`。

`task-store.mjs` 支持：

- `add`：添加任务
- `claim`：领取一个未完成任务
- `done` / `fail`：修改任务状态
- `status` / `current`：查看任务进度或当前任务
- `requeue`：把任务重新放回待处理
- `validate`：校验任务清单
- `dag-init`：初始化 DAG 并重置运行状态
- `dag-next`：找出下一个可执行 DAG 节点
- `dag-done` / `dag-fail`：修改 DAG 节点状态
- `dag-status`：查看 DAG 和任务进度
- `validate-dag`：校验 DAG 结构

这个仓库只管理 Pi 自己的配置，不写入其他工具的全局配置。

API 文档 Flow 的固定分层：

- `api-doc-plan-dag`：理解新需求，只创建 `.pi-flow/dag.json` 和 `.pi-flow/groups.ndjson`
- `api-doc-run-next`：读取 DAG 状态，只执行一个 ready 节点或一个 worker 任务
- `api-doc-fix-one`：领取一个 group，只读取该 group 的两个文件，只修改对应 `.gen.yaml`

这样 DAG 内容可以由 LLM 动态生成，但 Planner、Runner、Worker 的入口和权限边界是固定的。

从本地仓库安装：

```bash
./scripts/install.sh
```

脚本可以反复运行：

- 官方 Pi CLI 会先通过 `npm install -g` 安装或更新
- profile 内容没变时不会覆盖，也不会产生备份
- `pi-ghost` 启动脚本内容没变时不会重写
- profile 明确废弃的 Extension 会被移除
- Skill 和 Flow 文件内容没变时不会重写
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

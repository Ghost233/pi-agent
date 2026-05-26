# Pi Ghost DAG

`pi-ghost-dag` 是本地 DAG Runtime 和 Dashboard，用来做可视化计划编排、循环任务执行、人工审核关卡和 blocker 处理。
它会作为运行时资源安装到独立 Pi agent 目录，不是 Pi Skill。

## 边界

- `pi-ghost` 保持为标准 Pi agent 入口。
- `pi-ghost-dag` 启动本地 Dashboard 和 Runtime API。
- 运行状态保存在目标项目的 `.pi-flow/` 目录。
- UI 是主要入口。Tauri 启动器使用内置 Rust server binary，旧的脚本只保留为开发和兼容辅助。

## 运行时目录

```text
.pi-flow/
  dag.json
  tasks.ndjson
  state.json
  runs/
```

## 状态

- `pending`：等待依赖或 runner 调度。
- `ready`：当前可执行。
- `running`：正在执行。
- `done`：已完成。
- `failed`：执行失败，需要检查。
- `blocked`：需要用户决策。
- `waiting_review`：等待用户审核后继续。
- `skipped`：已明确跳过。

## 使用

从目标项目根目录启动：

```bash
pi-ghost-dag /path/to/project
```

打开输出的本地地址，在 Dashboard 里操作 DAG。

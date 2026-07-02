# agent-comms 多 Pi 协作设计

## 目标

`pi-ghost` 引入 `agent-comms` 的目标是把多个独立 Pi 会话组成一个可双向沟通的 agent team。

第一版不追求把所有 agent 塞进同一个终端，也不追求实时 attach 官方 subagent。每个 agent 可以运行在自己的终端里，用户能直接切到对应终端看实时输出；agent 之间通过 `agent-comms` 发消息、进房间、汇报状态和请求协助。

## 背景问题

官方 subagent 更像一次后台工具调用：

```text
主 Pi
  -> 调用 subagent
  -> 等待结构化结果
```

这个模型适合短任务和一次性委托，但有几个痛点：

- 子代理运行时不容易实时查看过程。
- 长任务卡住时，主会话只能看到等待状态。
- 子代理默认不是平等会话，不能自然双向沟通。
- 想让 Pi、Codex、Claude Code 互相协作时，官方 subagent 模型不够通用。

因此这里把问题拆开：

```text
多 agent 双向沟通       -> agent-comms
官方 subagent 实时可视化 -> 另一个问题，后续单独处理
```

## 为什么引入 agent-comms

`agent-comms` 提供一个本机 agent 通信 mesh。每个 Pi、Codex、Claude Code 或其他 MCP harness 都可以注册为一个 agent，然后通过 room 或 DM 通信。

引入它的原因：

1. **不改 Pi 官方 subagent 插件**
   避免维护 fork，也避免 Pi 升级冲突。

2. **支持真正双向沟通**
   不再只有主代理调用子代理。任意两个 agent 都可以互相发消息。

3. **支持多终端可见协作**
   一个终端运行主 Pi，一个终端运行 reviewer Pi，一个终端运行 planner Pi。用户直接切终端看实时状态。

4. **后续能接 Codex / Claude Code**
   `agent-comms` 有 MCP/Codex/Claude Code bridge，不锁死在 Pi 内部。

5. **有最小协作状态**
   支持 agent list、presence、room、DM、delivery/read receipt、`steer/followUp/info` 消息语义。

6. **和现有 pi-ghost 配置兼容**
   它只是一个 Pi extension，可以作为 `pi-ghost` 的默认安装项，不需要改 runtime。

## 不解决什么

`agent-comms` 不负责解决这些问题：

- 不显示官方 subagent 的 stdout。
- 不 attach 官方 subagent 的工具调用流。
- 不把多个 Pi 终端合并成一个 UI。
- 不负责持久化任务结果。
- 不替代 DAG runtime。

如果目标是“点一个 tab 看官方 subagent 正在干什么”，需要另做 subagent observer 或 runtime heartbeat。这和 `agent-comms` 是两条线。

## 目标架构

推荐第一版架构：

```text
Terminal 1: pi-ghost orchestrator
  - 负责主编排
  - 分配任务
  - 汇总结论

Terminal 2: pi-ghost reviewer
  - 负责审查方案、diff、风险

Terminal 3: pi-ghost planner
  - 负责拆计划、找依赖、补上下文

Terminal 4: pi-ghost executor 或 Codex
  - 负责执行局部任务
```

通信层：

```text
agent-comms localhost mesh
  - room: 项目公共频道
  - DM: 点对点任务请求
  - presence: active / idle / busy / offline
  - delivery/read receipt: 送达和已读反馈
```

官方 subagent 仍可保留：

```text
主 Pi
  - 用 subagent 做短、封闭、一次性任务
  - 用 agent-comms 找长期在线的 reviewer/planner/executor
```

## pi-ghost 配置

`agent-comms` 已加入 `profiles/pi-ghost.toml`：

```toml
[[extensions]]
name = "agent-comms"
source = "npm:agent-comms"
enabled = true
```

重新安装或更新 `pi-ghost` 配置后，新的 `pi-ghost` 会话应能看到 `agent_comms` 工具：

```bash
./scripts/install.sh
```

只预览：

```bash
./scripts/install.sh --dry-run
```

## 启动约定

每个终端启动后，先注册自己的角色。

主编排者：

```ts
agent_comms({
  action: "register",
  name: "orchestrator",
  visibility: "visible",
  tags: ["lead", "pi-ghost"]
})
```

审查者：

```ts
agent_comms({
  action: "register",
  name: "reviewer",
  visibility: "visible",
  tags: ["review", "risk"]
})
```

规划者：

```ts
agent_comms({
  action: "register",
  name: "planner",
  visibility: "visible",
  tags: ["plan", "context"]
})
```

执行者：

```ts
agent_comms({
  action: "register",
  name: "executor",
  visibility: "visible",
  tags: ["execute", "code"]
})
```

查看当前 agent：

```ts
agent_comms({ action: "list_agents" })
```

查看自己身份：

```ts
agent_comms({ action: "whoami" })
```

## Room 使用方式

为每个项目建一个公共 room，例如：

```ts
agent_comms({
  action: "create_room",
  name: "pi-ghost",
  type: "public",
  description: "pi-ghost project coordination"
})
```

其它 agent 加入：

```ts
agent_comms({
  action: "join_room",
  room: "pi-ghost"
})
```

广播状态：

```ts
agent_comms({
  action: "send",
  target: "pi-ghost",
  content: "reviewer: finished config review, no blocking issue found.",
  streamingBehavior: "info"
})
```

读取 room 历史：

```ts
agent_comms({
  action: "read_room",
  room: "pi-ghost"
})
```

## DM 使用方式

主 Pi 请求 reviewer 审查：

```ts
agent_comms({
  action: "dm",
  target: "reviewer",
  content: "请审查 agent-comms 引入方案。重点看：是否破坏 subagent 模型、是否需要改 Pi 官方插件、是否有安装风险。",
  streamingBehavior: "steer"
})
```

reviewer 回主 Pi：

```ts
agent_comms({
  action: "dm",
  target: "orchestrator",
  content: "审查完成：方案可行。建议先用多终端 Pi，不要先做 subagent attach。",
  streamingBehavior: "followUp"
})
```

## 消息语义

`streamingBehavior` 用来告诉接收方消息紧急度：

```text
steer    -> 尽快处理，适合阻塞问题、需要决策、紧急审查
followUp -> 当前任务结束后处理，适合补充信息
info     -> 普通状态广播
```

默认约定：

- 请求对方做事：`steer`
- 汇报阶段完成：`info`
- 给对方补上下文：`followUp`

## 建议消息格式

为了减少来回追问，任务请求尽量结构化：

```text
任务：审查 agent-comms 引入方案
上下文：pi-ghost 希望多 Pi 双向沟通，subagent 可视化另做
输入：profiles/pi-ghost.toml 和 README 变更
请输出：
1. 是否可行
2. 风险
3. 是否建议继续
限制：不要修改代码，只返回审查结论
```

短消息可以直接写：

```text
请看 README agent-comms 设计文档，重点挑不成立的假设。
```

## 和 subagent 的关系

两者可以同时存在，但分工不同：

```text
agent-comms
  - 多个独立 agent 的通信层
  - 适合长期在线、可观察、可双向沟通的团队成员

subagent
  - 主 Pi 内部的一次性后台任务
  - 适合短任务、封闭任务、结构化返回
```

推荐规则：

- 需要实时看过程：开独立 Pi 终端，用 `agent-comms`。
- 需要一次性后台跑完：用 subagent。
- 需要多角色长期协作：用多个 Pi + `agent-comms`。
- 需要官方 subagent UI attach：后续单独做 observer，不塞进 `agent-comms`。

## Pi 和 Codex 的后续接入

后续 Codex 可以通过 MCP bridge 接入同一个 mesh：

```toml
[mcp_servers.agent-comms]
command = "npx"
args = ["agent-comms", "bridge", "codex"]
```

接入后，Codex 也会成为一个 agent：

```text
orchestrator Pi
  <-> reviewer Pi
  <-> planner Pi
  <-> Codex executor/reviewer
```

第一版不自动写 Codex 全局配置。`pi-ghost` 仓库只管理 Pi 隔离环境，Codex 配置由用户单独决定。

## 验收标准

最小验收：

1. 运行 `./scripts/install.sh` 后，`pi-ghost` 自动安装 `npm:agent-comms`。
2. 开两个 `pi-ghost` 终端，分别注册 `orchestrator` 和 `reviewer`。
3. `orchestrator` 调用 `list_agents` 能看到 `reviewer`。
4. `orchestrator` 能 DM `reviewer`。
5. `reviewer` 能 DM 回 `orchestrator`。
6. room 消息可以广播给所有加入的 agent。

不把“官方 subagent 实时输出可见”列入本设计验收。

## 风险和边界

- `agent-comms` 主路径是本机 localhost mesh，不作为远程跨机器方案依赖。
- agent 身份是会话级的，重启后可能变化。
- 它是通信层，不是任务数据库；关键结果仍要写入项目文件、DAG state 或普通 git diff。
- 如果 npm 包的 Pi manifest 安装路径和实际发布文件不一致，需要单独验证 `pi install npm:agent-comms`。验证失败时，先固定安装方式，不改官方 subagent。

## 实施顺序

```text
1. pi-ghost 配置默认安装 agent-comms
2. 用两个 pi-ghost 终端验证 Pi <-> Pi DM
3. 建项目 room，约定角色注册和消息格式
4. 把 reviewer/planner/executor 从“官方 subagent 黑盒”迁移为“可见独立 Pi”
5. 再接 Codex MCP bridge
6. 最后单独评估官方 subagent observer
```

## 当前结论

`agent-comms` 解决的是“多个 agent 能不能平等、双向、可见地协作”。

它不解决“官方 subagent 内部过程如何 attach”。因此 `pi-ghost` 应先用 `agent-comms + 多终端 Pi` 建立可见 agent team，再把 subagent 可视化作为独立问题处理。

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

这个仓库只管理 Pi 自己的配置，不写入其他工具的全局配置。

从本地仓库安装：

```bash
./scripts/install.sh
```

脚本可以反复运行：

- 官方 Pi CLI 会先通过 `npm install -g` 安装或更新
- profile 内容没变时不会覆盖，也不会产生备份
- `pi-ghost` 启动脚本内容没变时不会重写
- profile 明确废弃的 Extension 会被移除
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

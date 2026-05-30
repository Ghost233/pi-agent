import type {
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	ToolCallEvent,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";

type GuardPhase = "idle" | "waiting" | "subagent_running" | "released" | "subagent_failed";

interface GuardState {
	phase: GuardPhase;
	reason: string;
	promptPreview: string;
	firstSubagentToolCallId?: string;
}

const GUARD_STATUS_KEY = "team-leader-guard";

const TEAM_MARKERS = [
	/team[- ]?leader/i,
	/team\s+leader/i,
	/leader\s*mode/i,
	/team\s*mode/i,
	/team-scout/i,
	/team-planner/i,
	/team-worker/i,
	/team-reviewer/i,
	/team-oracle/i,
	/team-validator/i,
	/subagent/i,
	/子代理/,
	/组队/,
	/队长/,
	/leader模式/i,
];

const NONTRIVIAL_TASK_MARKERS = [
	/bug/i,
	/fix/i,
	/debug/i,
	/investigat/i,
	/implement/i,
	/review/i,
	/validate/i,
	/refactor/i,
	/检查/,
	/调查/,
	/定位/,
	/修复/,
	/实现/,
	/验证/,
	/审查/,
	/重构/,
	/卡住/,
	/无法/,
	/概率/,
	/启动页/,
	/进入/,
	/崩溃/,
	/异常/,
];

const TRIVIAL_MARKERS = [
	/^\s*(hi|hello|thanks|thank you)\s*$/i,
	/^\s*(你好|谢谢|好的|ok)\s*$/i,
];

const TEAM_LEADER_SKILL_BLOCK = /^<skill\s+name=["']team-leader["'][^>]*>\n[\s\S]*?\n<\/skill>(?:\n\n([\s\S]*))?$/;
const TEAM_LEADER_SKILL_COMMAND = /^\s*\/skill:team-leader(?:\s+([\s\S]*))?$/;

const GUARD_SYSTEM_INSTRUCTION = `

[team-leader-guard runtime rule]
The Team Leader runtime guard is active for this turn.
Your first tool call must be the \`subagent\` tool.
Do not call any local discovery, shell, read, edit, write, search, index, planning, todo, or validation tool until the first \`subagent\` tool result has returned successfully.
If the \`subagent\` tool is unavailable or fails, stop and report that the leader workflow cannot proceed with delegation in this session.
[/team-leader-guard runtime rule]`;

const idleState = (): GuardState => ({
	phase: "idle",
	reason: "",
	promptPreview: "",
});

let guard: GuardState = idleState();

function textPreview(text: string): string {
	const normalized = text.replace(/\s+/g, " ").trim();
	return normalized.length <= 160 ? normalized : `${normalized.slice(0, 157)}...`;
}

function isTrivialPrompt(prompt: string): boolean {
	return TRIVIAL_MARKERS.some((pattern) => pattern.test(prompt));
}

function isNontrivialTask(prompt: string): boolean {
	const text = prompt.trim();
	if (text.length < 12 || isTrivialPrompt(text)) return false;
	return text.length > 80 || NONTRIVIAL_TASK_MARKERS.some((pattern) => pattern.test(text));
}

function hasExplicitTeamLeaderIntent(prompt: string): boolean {
	return TEAM_MARKERS.some((pattern) => pattern.test(prompt));
}

function teamLeaderSkillTaskText(prompt: string): string | undefined {
	const blockMatch = prompt.match(TEAM_LEADER_SKILL_BLOCK);
	if (blockMatch) return blockMatch[1]?.trim() ?? "";

	const commandMatch = prompt.match(TEAM_LEADER_SKILL_COMMAND);
	if (commandMatch) return commandMatch[1]?.trim() ?? "";

	return undefined;
}

function shouldActivateFromInput(event: InputEvent): boolean {
	if (event.source === "extension") return false;

	const skillTask = teamLeaderSkillTaskText(event.text);
	if (skillTask !== undefined) return isNontrivialTask(skillTask);

	return hasExplicitTeamLeaderIntent(event.text) && isNontrivialTask(event.text);
}

function shouldActivateFromAgentStart(event: BeforeAgentStartEvent): boolean {
	const skillTask = teamLeaderSkillTaskText(event.prompt);
	if (skillTask !== undefined) return isNontrivialTask(skillTask);

	return hasExplicitTeamLeaderIntent(event.prompt) && isNontrivialTask(event.prompt);
}

function activateGuard(reason: string, prompt: string, ctx: ExtensionContext): void {
	guard = {
		phase: "waiting",
		reason,
		promptPreview: textPreview(prompt),
	};
	ctx.ui.setStatus(GUARD_STATUS_KEY, "Team Leader: waiting for subagent");
}

function clearGuard(ctx?: ExtensionContext): void {
	guard = idleState();
	ctx?.ui.setStatus(GUARD_STATUS_KEY, undefined);
}

function isSubagentTool(toolName: string): boolean {
	return toolName === "subagent";
}

function isSubagentChildProcess(): boolean {
	return process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_SUBAGENT_FANOUT_CHILD === "1";
}

function isExecutionSubagentInput(input: Record<string, unknown>): boolean {
	if (Array.isArray(input.tasks) && input.tasks.length > 0) return true;
	if (Array.isArray(input.chain) && input.chain.length > 0) return true;
	if (typeof input.agent === "string" && input.agent.trim().length > 0 && input.action === undefined) return true;
	return false;
}

function blockReason(toolName: string): string {
	if (guard.phase === "subagent_running") {
		return `Team Leader guard blocked ${toolName}: the first subagent call has started, but local tools remain blocked until that subagent result returns.`;
	}
	if (guard.phase === "subagent_failed") {
		return `Team Leader guard blocked ${toolName}: the first subagent call failed. Stop and report that delegated execution is unavailable instead of continuing as a solo agent.`;
	}
	return `Team Leader guard blocked ${toolName}: for this nontrivial Team Leader task, the first tool call must be subagent. Delegate to team-scout or team-planner before using local tools.`;
}

function notifyBlocked(ctx: ExtensionContext, toolName: string): void {
	if (!ctx.hasUI) return;
	ctx.ui.notify(
		`Team Leader guard 已阻止 ${toolName}。请先调用 subagent；首个 subagent 成功返回前不能使用本地工具。`,
		"warning",
	);
}

function statusForPhase(): string | undefined {
	switch (guard.phase) {
		case "waiting":
			return "Team Leader: waiting for subagent";
		case "subagent_running":
			return "Team Leader: subagent running";
		case "subagent_failed":
			return "Team Leader: subagent failed";
		case "released":
			return "Team Leader: delegated";
		case "idle":
			return undefined;
	}
}

export default function teamLeaderGuard(pi: ExtensionAPI) {
	if (isSubagentChildProcess()) return;

	pi.on("input", (event, ctx) => {
		if (!shouldActivateFromInput(event)) return undefined;

		activateGuard(
			teamLeaderSkillTaskText(event.text) !== undefined ? "team-leader skill command" : "explicit Team Leader request",
			event.text,
			ctx,
		);
		return {
			action: "continue",
		};
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!shouldActivateFromAgentStart(event)) return undefined;

		if (guard.phase === "idle") {
			activateGuard(
				teamLeaderSkillTaskText(event.prompt) !== undefined ? "team-leader skill active" : "explicit Team Leader request",
				event.prompt,
				ctx,
			);
		}

		return {
			systemPrompt: `${event.systemPrompt}${GUARD_SYSTEM_INSTRUCTION}`,
		};
	});

	pi.on("tool_call", (event: ToolCallEvent, ctx) => {
		if (guard.phase === "idle" || guard.phase === "released") return undefined;

		if (isSubagentTool(event.toolName)) {
			if (isExecutionSubagentInput(event.input) && (guard.phase === "waiting" || guard.phase === "subagent_failed")) {
				guard = {
					...guard,
					phase: "subagent_running",
					firstSubagentToolCallId: event.toolCallId,
				};
				ctx.ui.setStatus(GUARD_STATUS_KEY, statusForPhase());
			}
			return undefined;
		}

		notifyBlocked(ctx, event.toolName);
		return {
			block: true,
			reason: blockReason(event.toolName),
		};
	});

	pi.on("tool_result", (event: ToolResultEvent, ctx) => {
		if (guard.phase !== "subagent_running") return undefined;
		if (!isSubagentTool(event.toolName)) return undefined;
		if (guard.firstSubagentToolCallId && event.toolCallId !== guard.firstSubagentToolCallId) {
			return undefined;
		}

		guard = {
			...guard,
			phase: event.isError ? "subagent_failed" : "released",
		};
		ctx.ui.setStatus(GUARD_STATUS_KEY, statusForPhase());
		return undefined;
	});

	pi.on("turn_end", (_event, ctx) => {
		if (guard.phase === "released") {
			clearGuard(ctx);
			return;
		}

		ctx.ui.setStatus(GUARD_STATUS_KEY, statusForPhase());
	});

	pi.on("agent_end", (_event, ctx) => {
		clearGuard(ctx);
	});

	pi.registerCommand("team-leader-guard", {
		description: "Show Team Leader guard state.",
		handler: async (_args, ctx) => {
			if (guard.phase === "idle") {
				ctx.ui.notify("Team Leader guard 当前未激活。", "info");
				return;
			}

			ctx.ui.notify(
				`Team Leader guard 当前状态: ${guard.phase}; reason=${guard.reason}; prompt=${guard.promptPreview}`,
				"info",
			);
		},
	});
}

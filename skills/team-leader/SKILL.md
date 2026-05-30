---
name: team-leader
description: Coordinate Pi subagents as a user-facing team leader. Use for nontrivial coding tasks, broad codebase investigation, implementation planning, multi-agent review, or when the user asks for team/leader mode.
---

# Team Leader

Use this skill only from the user-facing top-level session. If you are a
delegated subagent or child session, do not use this skill unless the parent
explicitly assigned you to supervise a bounded fanout.

## Operating Model

The user talks to the leader. The leader talks to teammates. The leader owns
final judgment, tradeoffs, execution order, and the user-facing summary.

Teammate output is evidence. Do not blindly follow it. Resolve conflicts by
checking the code, asking a narrower teammate, or asking the user when the
decision is product-level or high-risk.

## Delegation First

For any nontrivial bug investigation, broad codebase question, implementation
task, review request, or validation request, your first meaningful action must
be to call the `subagent` tool or a `/run`, `/chain`, or `/parallel` shortcut.
Do not begin with local file search/read/edit yourself unless the task is small
enough that delegation would add no value.

Hard gate:

- If this skill is active and the user's task is nontrivial, the first tool call
  must be `subagent`.
- Before that first subagent call returns, do not call local discovery or edit
  tools: find, grep, read, bash, edit, write, index/findex/search helpers, or
  any project-specific code navigation tool.
- Do not narrate a plan to inspect files yourself. Delegate the inspection.
- If you cannot call `subagent`, stop. Do not continue as a solo agent.

If you are in the top-level session and cannot see or call the `subagent` tool,
do not silently continue as a solo agent. Tell the user that subagent execution
is not available in this session and that the leader workflow cannot proceed
until the session is reloaded with the subagent extension active.

## Default Routing

- Unknown code area: ask `team-scout` to map relevant files, entry points,
  flows, risks, and suggested next reads.
- Bigger change: ask `team-planner` for a bounded implementation plan before
  editing.
- Risky design choice, unclear tradeoff, or suspected drift: ask `team-oracle`
  for a second opinion before acting.
- Approved implementation: ask `team-worker` to execute a narrow task with an
  explicit write scope and validation command.
- Finished code change: ask `team-reviewer` before the final response.
- Behavior-sensitive or test-sensitive change: ask `team-validator` for command
  evidence and residual risk.
- Broad or high-risk diff: run parallel `team-reviewer` tasks with distinct
  focus areas such as correctness, tests, safety, and unnecessary complexity.

## Invocation Shapes

Prefer direct tool calls when available:

```ts
{ agent: "team-scout", task: "Map the relevant code for: <user task>. Read-only. Return paths, flows, risks, and next recommended agent task.", context: "fresh" }
```

```ts
{ chain: [
  { agent: "team-scout", task: "Map relevant code for: <user task>. Read-only." },
  { agent: "team-planner", task: "Use the scout result to propose a bounded plan. Do not edit." }
] }
```

```ts
{ tasks: [
  { agent: "team-reviewer", task: "Review the diff for correctness and regressions." },
  { agent: "team-reviewer", task: "Review the diff for missing tests and validation gaps." },
  { agent: "team-reviewer", task: "Review the diff for unnecessary complexity and safety issues." }
], context: "fresh" }
```

Use background execution only when useful:

```ts
{ agent: "team-scout", task: "Long-running read-only investigation: <scope>", async: true }
```

## Delegation Rules

- Keep every teammate task bounded: goal, scope, allowed reads, allowed writes,
  validation expectation, and stop condition.
- Do not delegate trivial tasks that are faster and safer to do directly.
- Do not let implementation teammates decide product scope, destructive actions,
  credential handling, or external publication.
- Use background/asynchronous delegation only when the leader has useful work to
  continue or the task may take time.
- If a teammate reports `blocked`, either answer it as leader, ask the user one
  concise question, or stop the workflow.

## Synthesis

When teammates return:

1. Extract evidence, not prose volume.
2. Check disagreements against code or tests when feasible.
3. Decide the next step yourself.
4. Report only the useful conclusion to the user in Simplified Chinese.

For final answers after delegated work, include:

- What changed or what was learned.
- Which validation/review was run.
- Any remaining blocker or risk.

Do not include raw teammate transcripts unless requested.

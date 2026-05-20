---
name: api-doc-flow
description: Operate API documentation DAG flows with fixed Planner, Runner, Worker agents and task-store. Use for creating or running .pi-flow DAGs, claiming API doc tasks, or avoiding full groups files in context.
---

# API Doc Flow

Use this skill for API documentation repair DAGs. Keep one skill and three fixed
flow agents:

- Planner: `api-doc-plan-dag`
- Runner: `api-doc-run-next`
- Worker: `api-doc-fix-one`

## Rules

- Planner may write only `.pi-flow/dag.json`, `.pi-flow/groups.ndjson`, and `.pi-flow/state.json`.
- Runner may read DAG state and call one worker action; it must not re-plan.
- Worker may edit only the claimed task's `generated_file`.
- Do not read `.pi-flow/groups.json` or `.pi-flow/groups.ndjson` directly in normal execution.
- Use `scripts/task-store.mjs` for queue and DAG state.

## Flow Calls

Create a new DAG:

```json
{
  "flow": [
    {
      "type": "api-doc-plan-dag",
      "cwd": "/Users/ghost/code/api-doc",
      "sessionMode": "fast",
      "aim": "Plan API doc repair DAG",
      "intent": "Analyze the API documentation request, create .pi-flow/dag.json and .pi-flow/groups.ndjson, validate them, then stop."
    }
  ]
}
```

Run the next DAG step:

```json
{
  "flow": [
    {
      "type": "api-doc-run-next",
      "cwd": "/Users/ghost/code/api-doc",
      "sessionMode": "fast",
      "aim": "Run next API doc DAG step",
      "intent": "Read DAG state, execute exactly one ready node or worker task, update state, then stop."
    }
  ]
}
```

## Commands

```bash
node "$PI_CODING_AGENT_DIR/skills/api-doc-flow/scripts/task-store.mjs" dag-status --cwd "$PWD"
node "$PI_CODING_AGENT_DIR/skills/api-doc-flow/scripts/task-store.mjs" dag-next --cwd "$PWD"
node "$PI_CODING_AGENT_DIR/skills/api-doc-flow/scripts/task-store.mjs" validate-dag --cwd "$PWD"
node "$PI_CODING_AGENT_DIR/skills/api-doc-flow/scripts/task-store.mjs" status --cwd "$PWD"
node "$PI_CODING_AGENT_DIR/skills/api-doc-flow/scripts/task-store.mjs" current --cwd "$PWD"
node "$PI_CODING_AGENT_DIR/skills/api-doc-flow/scripts/task-store.mjs" requeue --cwd "$PWD" --id group-001
```

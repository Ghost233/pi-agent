---
name: api-doc-flow
description: Drive pi-agent-flow to process one queued API doc repair task with api-doc-fix-one/task-store. Use when asked to run the next API doc flow, claim a .pi-flow task, or avoid reading full groups files.
---

# API Doc Flow

Use this skill for API doc repair queues. It keeps large task files out of model
context and exposes only one claimed task at a time.

## Rules

- Do not read `.pi-flow/groups.json` or `.pi-flow/groups.ndjson` directly.
- Use `scripts/task-store.mjs` for add, claim, done, fail, status, current,
  requeue, and validate.
- Handle exactly one claimed task per invocation.
- Project state stays in `.pi-flow/state.json`; scripts stay in this skill.

## Flow Invocation

Call one flow from root state:

```json
{
  "flow": [
    {
      "type": "api-doc-fix-one",
      "cwd": "/Users/ghost/code/api-doc",
      "sessionMode": "fast",
      "aim": "Fix next API group",
      "intent": "Claim exactly one pending API documentation task, compare the source document with the generated YAML, update only that generated YAML if needed, update state, then stop."
    }
  ]
}
```

`api-doc-fix-one` calls:

```bash
node "$PI_CODING_AGENT_DIR/skills/api-doc-flow/scripts/task-store.mjs" claim --cwd "$PWD"
node "$PI_CODING_AGENT_DIR/skills/api-doc-flow/scripts/task-store.mjs" done --cwd "$PWD" --id group-001
node "$PI_CODING_AGENT_DIR/skills/api-doc-flow/scripts/task-store.mjs" fail --cwd "$PWD" --id group-001 --reason "source document is ambiguous"
```

Useful operator commands:

```bash
node "$PI_CODING_AGENT_DIR/skills/api-doc-flow/scripts/task-store.mjs" add --cwd "$PWD" --from .pi-flow/new-groups.ndjson
node "$PI_CODING_AGENT_DIR/skills/api-doc-flow/scripts/task-store.mjs" status --cwd "$PWD"
node "$PI_CODING_AGENT_DIR/skills/api-doc-flow/scripts/task-store.mjs" current --cwd "$PWD"
node "$PI_CODING_AGENT_DIR/skills/api-doc-flow/scripts/task-store.mjs" requeue --cwd "$PWD" --id group-001
node "$PI_CODING_AGENT_DIR/skills/api-doc-flow/scripts/task-store.mjs" validate --cwd "$PWD"
```

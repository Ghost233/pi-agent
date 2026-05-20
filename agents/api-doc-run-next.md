---
name: api-doc-run-next
description: Read the API documentation DAG state and execute exactly one ready node or worker task.
tools: batch bash find grep ls
maxDepth: 1
tier: flash
---

mission: Read `.pi-flow/dag.json` state, choose the next executable DAG step, run exactly one action, update state, then stop.

workflow:
1 Run `node "$PI_CODING_AGENT_DIR/skills/api-doc-flow/scripts/task-store.mjs" dag-next --cwd "$PWD"`.
2 If the status is `DAG_DONE`, `DAG_BLOCKED`, `INVALID_DAG`, or `BLOCKED_DAG_NOT_FOUND`, report it and stop.
3 If `action` is `run_worker` and `node.worker` is `api-doc-fix-one`, invoke exactly one child flow in the same cwd:
   `{ "flow": [{ "type": "api-doc-fix-one", "cwd": "$PWD", "sessionMode": "fast", "aim": "Fix one API doc group", "intent": "Claim one pending API documentation task, repair only its generated YAML, update task state, then stop." }] }`
4 After the child flow returns, run `node "$PI_CODING_AGENT_DIR/skills/api-doc-flow/scripts/task-store.mjs" dag-next --cwd "$PWD"` once more to let the DAG state advance if the map node is complete.
5 If `action` is `summarize_result`, run `node "$PI_CODING_AGENT_DIR/skills/api-doc-flow/scripts/task-store.mjs" status --cwd "$PWD"`, report the compact summary, then run `node "$PI_CODING_AGENT_DIR/skills/api-doc-flow/scripts/task-store.mjs" dag-done --cwd "$PWD" --id summarize-result`.
6 For any unsupported action, run `node "$PI_CODING_AGENT_DIR/skills/api-doc-flow/scripts/task-store.mjs" dag-fail --cwd "$PWD" --id <node-id> --reason "unsupported action"` and stop.

rules:
Do not plan or rewrite the DAG.
Do not read `.pi-flow/groups.json` or `.pi-flow/groups.ndjson` directly.
Do not modify API documentation files from this runner. Only the worker flow may modify the claimed `.gen.yaml`.
Run only one worker task per invocation.
Output only the node id, action, worker result, DAG status, and blocker if any.

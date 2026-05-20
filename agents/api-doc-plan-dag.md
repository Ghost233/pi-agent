---
name: api-doc-plan-dag
description: Analyze an API documentation request and create a validated DAG plus task queue.
tools: batch bash find grep ls
maxDepth: 0
tier: flash
---

mission: Turn one API documentation repair request into `.pi-flow/dag.json` and `.pi-flow/groups.ndjson`, validate them, then stop.

workflow:
1 Create `.pi-flow/` if needed.
2 Scan the requested API documentation root with shell tools. Do not modify API source documents or generated YAML files.
3 Identify each `.gen.yaml` file and its matching original description file.
4 Write one task per pair to `.pi-flow/groups.ndjson`. Each line must be a complete JSON object with `id`, `status`, `files`, `source_file`, `generated_file`, `matched`, `reason`, and `task`.
5 Create `.pi-flow/dag.json` with exactly these nodes:
   - `build-groups`, type `group_api_docs`, status `done`
   - `fix-api-docs`, type `map_group`, depends on `build-groups`, worker `api-doc-fix-one`, input groups `.pi-flow/groups.ndjson`
   - `summarize-result`, type `summarize_result`, depends on `fix-api-docs`
6 Run `node "$PI_CODING_AGENT_DIR/skills/api-doc-flow/scripts/task-store.mjs" dag-init --cwd "$PWD" --from .pi-flow/dag.json`.
7 Run `node "$PI_CODING_AGENT_DIR/skills/api-doc-flow/scripts/task-store.mjs" validate --cwd "$PWD" --groups .pi-flow/groups.ndjson`.
8 Run `node "$PI_CODING_AGENT_DIR/skills/api-doc-flow/scripts/task-store.mjs" validate-dag --cwd "$PWD"`.

rules:
Only write `.pi-flow/dag.json`, `.pi-flow/groups.ndjson`, and `.pi-flow/state.json`.
Do not read `.pi-flow/groups.ndjson` back into the conversation after writing it.
Do not create new worker names or node types.
Do not modify any API documentation file or `.gen.yaml`.
If matching is uncertain, keep the task, set `matched` to false, and explain the uncertainty in `reason`.
Output only the DAG path, task count, validation status, and uncertainty count.

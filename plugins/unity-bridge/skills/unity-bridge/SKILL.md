---
name: unity-bridge
description: Inspect and operate a running Unity Editor through the local Unity Bridge, including scene hierarchy, C# evaluation, logs, screenshots, and recovery of timed-out commands. Use for live Unity Editor work after the bridge package is installed; ordinary source edits can use normal file tools.
---

# Unity Bridge

Use the bundled Node 18+ client at `scripts/unity-bridge.mjs`. Resolve its path relative to this SKILL.md; never assume a user-specific installation directory. This is a command-line program invoked with the existing shell tool, not Codex CLI or an MCP server.

1. Run `node <client> list` and select the intended project. For work in an identified project, pass `--project <absolute project root>` to every command. If multiple Editors match, resolve the target before executing. `health` verifies the selected Editor and reports compilation, Play Mode and bridge version.
2. Prefer `hierarchy`, `logs`, `state` and `screenshot --output <new PNG path>` for routine inspection. These do not compile snippets. Screenshot requires graphics and an open Scene view. View the saved image to verify visual work.
3. Use `exec --file <UTF-8 snippet.cs>` for custom work. Files contain a **synchronous C# method body**, with `UnityEngine`, `UnityEditor`, `System`, collections and LINQ already imported. Use `return` for values; `byte[]` is supported. Compiler is Unity's bundled Roslyn, language version C# 9, with Editor/project references. Framework availability still follows the project's API compatibility level. Avoid `async void`; returning Task does not wait for it.
4. Inspect before modifying intentional scene/prefab/asset configuration. For changes, use Unity's Undo, prefab and dirty/save APIs as appropriate; executing C# does not automatically create Undo records, save assets, or roll back partial failure. Do not save unrelated user changes.
5. Each invocation prints its command ID before submission. A timeout/disconnect or interrupted client wait is **not cancellation**. Query `status <id>` or `wait <id>` using the same project/endpoint. Do not issue the write again with a new ID. A same-ID/same-payload submission deduplicates while retained; different payload returns conflict. `interrupted` may have partially executed. Unknown/evicted IDs also require inspecting project state before retrying. A binary file write error can occur after successful execution: query the completed job and save to a new path instead of executing the C# again.

Examples (replace `<client>` with the bundled script path):

```text
node <client> health --project <project>
node <client> hierarchy --project <project> --limit 200
node <client> exec --project <project> --file <snippet.cs> --timeout 60
node <client> wait <id> --project <project> --timeout 120
node <client> screenshot --project <project> --output <new.png>
```

Commands return JSON. Exit 0 means succeeded/accepted; exit 1 rejected/failed/cancelled/interrupted; exit 2 means outcome unknown or the wait budget expired. `--no-wait` returns an accepted job; it does not prove completion. `cancel <id>` only cancels queued work. Running code cannot be safely preempted; an infinite loop can freeze Unity. Queue expiry prevents delayed queued commands from executing, but does not stop an already-running snippet.

Jobs/results live under the project's `Library/UnityBridge/jobs`; the latest 128 are retained. Do not delete these while resolving an uncertain write. Domain reload restores status without replaying requests. Up to 128 unique snippet assemblies are loaded per domain; repeat snippets are cached. Use the Editor's `Tools > Unity Bridge > Reload Domain` when the explicit assembly limit is reached, after resolving in-flight writes.

If connection fails, confirm Unity is open and the Git-installed `com.retmnit.unity-bridge` package is present. `Tools > Unity Bridge > Start` enables it. Do not change the project's dependency to an absolute disk path. Optional `UNITY_BRIDGE_TOKEN` and `UNITY_BRIDGE_URL` configure authentication/endpoint; never print tokens. No browser is needed for normal bridge operations.

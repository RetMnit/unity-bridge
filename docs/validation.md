# Validation — 0.2.0

Validated on 2026-10-14 with Windows, Unity 2022.3.62f3 and Node 22.23.2. Tests used disposable projects, not a user's game project.

- Node client: 10 tests covering project selection/ambiguity, localhost origins, single submission with polling, lost POST response recovery IDs, fast terminal failures, wait timeout/eviction, stale discovery identity, binary file protection, authentication failures and per-request project identity.
- Editor: legacy HTTP contract, C# 9/local functions and formerly conflicting System types, cached snippets, deduplication/conflicts, source-mapped compiler errors, binary results, Editor/Engine module identities, generic Editor APIs, fixed inspection commands, malformed request/origin rejection and project mismatch guard.
- Recovery: status queries while the main thread executes, queued cancellation, queue expiry after long work, client timeout with later result retrieval, automatic restart after domain reload, retained results/dedup after reload.
- Forced process exit during a running snippet: durable running intent restores as interrupted with executionMayHaveOccurred=true; submitting the same ID does not execute it again.
- Two simultaneous Editors: separate ports 6417/6418, correct project selection. A project Editor assembly was callable from a snippet.
- Graphics-enabled Editor: a Scene view screenshot was saved as a 1280×720 PNG and visually inspected.
- Codex plugin: Skill frontmatter validator passed; local marketplace and plugin installation were accepted by the installed Codex client.
- Published Git dependency: a clean project resolved `v0.2.0` directly from GitHub, with source=git and the release commit in packages-lock.json; installed C# source matched after line-ending normalization. The Git-installed Codex plugin connected to that Editor and the Editor smoke checks passed.

Node tests do not require Unity. Editor/recovery/crash tests require an explicitly isolated project. `crash-smoke.mjs` additionally requires `--restart-isolated-editor` and the Unity executable path; it forcibly terminates that Editor and starts it again. Screenshot rendering is unavailable under `-nographics`.

In a graphical Editor, pending script reload may wait until the Unity window regains focus. Focus the Editor before running the recovery smoke test. Git URL installation also requires that the Git process launched by Unity can reach GitHub; terminal-only proxy environment variables are not automatically inherited by an Editor opened from Hub.

This validates the tested Editor version and workflows. It does not guarantee safe termination of arbitrary C#, automatic Undo/rollback, indefinite command deduplication, or compatibility with every Unity release or third-party package.

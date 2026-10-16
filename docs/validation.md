# Validation — 0.4.0

Package identity is `com.retmnit.unity-bridge`, namespace `UnityBridge`, and entry type `UnityBridgeServer`. The existing five `.meta` files match byte-for-byte and the `UnityBridge.Editor` assembly identity is preserved. All 43 Node tests and 17 source-package Editor smoke checks passed for the renamed package.

## Previous integration validation (0.3.1)

Validated on 2026-10-16 with Windows, Unity 2022.3.62f3 and Node 22.23.2. Tests used dedicated disposable projects; game projects were not modified.

All 43 Node regressions passed for 0.3.1, including model-visible execution flags, cancellation wording and a single uncertainty warning per failed query. The executor behavior is unchanged from 0.3.0.

- Shared client regressions cover explicit token propagation, pre-dispatch cancellation, cancellation after submission, interrupted polling, malformed/mismatched replies, server/query failures retaining IDs, artifact write failures, and a full 8 MiB binary result.
- DSH adapter tests cover native tool schema registration, the legacy `{code}` call shape, single submission, pre-submission ID recovery, uncertain outcomes, project targeting, authentication, binary artifacts, bounded rendering and the local `recent` journal.
- The DSH bundle loader and adapter were exercised against both mock servers and a real Editor: discovery/health, C# evaluation, compilation failures, binary file output and status queries.
- Editor smoke tests passed for the HTTP contract, C# 9/System and project API references, deduplication, cached snippets, diagnostics, binary output, inspection commands and project guards. Omitted inspection limits returned multiple log lines; an explicit limit of 1 returned one line.
- Recovery tests passed for status responsiveness while the main thread runs, queued cancellation/expiry, wait timeout followed by result recovery, domain reload and retained deduplication.
- The Git dependency resolved in a new project and upgraded to v0.3.1 with `source=git` and commit `bf545607755271f671f542a830ca6a65634a2cb2`. All 17 Editor smoke checks and 6 recovery checks passed against the final installation. Two simultaneous Editors used ports 6417/6418; the Git-installed Codex client selected the requested project and invoked its Editor assembly.
- Codex installed the tagged 0.3.1 plugin. DSH's bundle installed the same Git commit; package-lock was pinned to HTTPS and a clean `npm ci --ignore-scripts` succeeded. Installed UPM, Codex and DSH code matched the release source.
- After restarting Desktop, its original session directly invoked native `unity_execute` and `unity_bridge`: project selection, project assembly evaluation, status/recent, binary output and same-ID re-save, protected existing files, compilation failure, unknown IDs, short waits with later completion and queued cancellation all passed. CLI/mock calls did not substitute for this host check.
- A final native-session check against 0.3.1 confirmed that compilation failures visibly show `executionMayHaveOccurred=false`, cancelled jobs use cancellation guidance, and unknown-ID output preserves identity with one uncertainty warning.
- Desktop Host caches imported DSH plugin modules. Editing bundle files or touching profile configuration does not reload an existing preset's module. Restart Desktop after installing an adapter update; verify the actual tool table contains `unity_bridge` before using its new parameters.

## Previous full executor validation (0.2.0)

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

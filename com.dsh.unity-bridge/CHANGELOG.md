# Changelog — com.dsh.unity-bridge

## [0.3.0] - 2026-10-16

- Added a DSH-native adapter to the repository, sharing the same Node client as the Codex CLI for project selection, task submission/recovery, authentication and binary artifacts.
- Propagated caller cancellation through HTTP, discovery and polling. Cancelling the client wait never silently cancels or repeats an accepted Unity command; uncertain outcomes retain the original task ID.
- Preserved task identity on invalid/lost responses, status-query failures and artifact-save errors. Added response ID/state validation and a single submission/wait deadline budget.
- Corrected omitted inspection line limits to use 100 lines without changing persisted request fingerprints or protocol version.
- Release metadata, installation instructions and both host integrations are aligned to v0.3.0. Existing v0.2.0 protocol-2 Editors remain compatible with the new clients.

## [0.2.0] - 2026-10-14

- Agent-neutral Unity Bridge display name/menu; preserved package name, namespace, existing GUIDs and legacy HTTP execution contract.
- Replaced CodeDom with Unity's bundled Roslyn and canonical framework/Editor/project references. C# 9, local functions and System types are supported without the old facade conflicts. Compiler runs off the main thread, with UTF-8 source-mapped diagnostics and a 30 s compile deadline.
- Added project/PID/instance identity, cached state timestamps, automatic per-user discovery and port fallback for multiple Editors.
- Added asynchronous jobs with stable IDs, bounded deduplication, payload conflicts, durable status, recovery without replay, queued cancellation and dispatch-time expiry checks. Running status remains available while user code blocks the main thread.
- Added fixed state/hierarchy/log/screenshot operations, bounded logs/binary output, snippet caching and an explicit 128-assembly domain limit.
- Added an Editor-only assembly definition, request size/concurrency bounds, localhost Host checks, browser Origin rejection and optional Bearer authentication.
- Manual Stop persists across domain reload within the session; graceful shutdown records pending job outcomes.
- Added a zero-dependency Node CLI, Codex Skill/plugin, Git-based UPM installation, protocol docs and client/Editor tests in the repository.

## [0.1.2] - 2026-08-20

### Added
- **`byte[]` 返回值自动转 base64**：snippet 直接 `return <byte[]>`（如 `tex.EncodeToPNG()`）即可传文件，
  结果以 `@b64:` 前缀返回（解决了 snippet 内 `System.Convert` 因 CS0433 不可用而无法手写 base64 的问题）。
- **编译错误附带 `[DSH hint]`**：CodeDom 已知限制（System.IO.*/Convert/Enum/Array/List<T>/AppDomain 等
  CS0433 不可用、勿改引用逻辑、数组替代/byte[] 传文件/无局部函数）直接拼进错误信息，方便排查。

## [0.1.1] - 2026-08-16

### Added
- **域重载自动重启**（`Editor/DshBridge.cs` 新增 `DshBridgeAutoStart`）：
  - `[InitializeOnLoad]` 在每次域重载（改脚本 / 装包 / 进出 Play Mode）后自动拉起 HTTP 服务，
    不再需要手动点击 `Tools/DSH Bridge/Start`；
  - 重载前通过 `AssemblyReloadEvents.beforeAssemblyReload` 主动 `Stop()` 释放端口，
    避免 "Address already in use"；3 秒 watchdog 兜底重试。

## [0.1.0] - 首次版本

- 基础 HTTP 桥接：`GET /api/health`、`POST /api/execute`（CodeDom 编译执行 C#，主线程队列执行）。
- 菜单：`Tools/DSH Bridge/Start` / `Stop`。

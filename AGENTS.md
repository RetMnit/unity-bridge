# Unity Bridge — shared executor and clients

## Scope and layout
- `com.dsh.unity-bridge/`: Unity 2022.3 UPM package. Keep its package name and existing `.meta` GUIDs stable; display branding is agent-neutral.
- `plugins/unity-bridge/`: self-contained Codex Skill/CLI plugin. No MCP or user-specific paths.
- `adapters/dsh/`: DSH-native tools, using the same Node client through portable relative imports. Local presets install this package from its Git release.
- `.agents/plugins/marketplace.json`: installable plugin catalog.
- `tests/`: Node client tests and explicitly isolated-Editor smoke tests.
- `docs/protocol.md`: public wire contract, failure semantics and DSH adaptation guidance.

## Compatibility
- Current release is 0.3.1 / protocol 2. Preserve legacy `GET /api/health` and `POST /api/execute` result/logs/error semantics.
- Interface changes require a package/plugin version update and CHANGELOG entry. Keep DSH and Codex documentation aligned. Breaking changes require coordinating both clients.
- Unity projects install by HTTPS Git URL with `?path=/com.dsh.unity-bridge#<version-tag>`, never by a hardcoded disk dependency. Source edits do not update projects until a new revision is installed.
- Authentication is optional through an environment variable. Never commit credentials, discovery descriptors, user project paths, test caches or binary compiler dependencies.

## Engineering invariants
- Unity API and user code run on the main thread; child-process compilation and HTTP handling must not block the main thread or hold the shared state lock while executing user code or writing large HTTP responses.
- Persist running intent before executing. A timeout is not cancellation. Restore state without replay; ID deduplication only covers retained history. Check queue expiry immediately before execution selection.
- Use Unity's bundled Roslyn/.NET host and canonical framework references plus Editor/project assemblies. Do not use CodeDom or reference every runtime System assembly.
- Loaded assemblies cannot be individually unloaded. Cache repeated snippets and enforce the explicit per-domain limit.
- Changing scene/prefab/project configuration requires understanding user intent; do not treat an unusual setting as a bug.

## Validation and release
- Run `npm test`. Use the Editor smoke tests only on a dedicated disposable project; recovery tests deliberately delay the main thread and reload the domain.
- Verify Unity 2022.3 compilation/evaluation, legacy endpoint, modern C#/System types, job deduplication/conflicts, queue cancellation/expiry, domain/crash recovery, multi-Editor targeting and screenshot output when graphics are available.
- Before publishing, inspect the tracked-file list for local/private artifacts. Commit, create an immutable version tag and push main plus that tag. Confirm remote SHA and install the tagged UPM dependency in a clean test project.
- Do not force-push or move a published release tag to fix code; publish a new version.

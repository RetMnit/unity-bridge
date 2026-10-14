# Changelog — com.dsh.unity-bridge

DSH ↔ Unity 编辑器桥接 UPM 包（本地 HTTP 服务 127.0.0.1:6417，供 DSH `unity_execute` 调用）。

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

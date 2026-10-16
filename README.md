# Unity Bridge

面向 Unity **2022.3 LTS** 的本地编辑器桥接。Unity 端与 agent 无关；Codex 通过随附 CLI/Skill 调用，DSH 通过原生 `unity_execute` / `unity_bridge` 工具调用。两端共用一个 Node 客户端，不依赖 Unity AI、MCP、额外 API key 或系统安装的 .NET SDK。

## Unity 安装：Git URL

在 Package Manager 中选择 **Add package from git URL**，输入：

```text
https://github.com/RetMnit/unity-bridge.git?path=/com.dsh.unity-bridge#v0.3.1
```

也可在项目 `Packages/manifest.json` 的 `dependencies` 中添加：

```json
"com.dsh.unity-bridge": "https://github.com/RetMnit/unity-bridge.git?path=/com.dsh.unity-bridge#v0.3.1"
```

包名保持 `com.dsh.unity-bridge` 以兼容已有工程；显示名和菜单是 **Unity Bridge**。编辑器加载后自动启动，菜单 `Tools > Unity Bridge > Start/Stop` 可手动控制。Stop 在当前编辑器会话内跨域重载保持有效。

依赖固定到标签，不跟随本地源码修改。升级时替换为新的已发布标签；开发者在此仓库改源码并提交、打标签、推送，项目内的 PackageCache 不用于开发。无需任何硬编码磁盘引用。

如果 Package Manager 报 GitHub `Connection was reset`，先核对 Unity 启动环境的 Git 网络访问。终端的临时代理变量不会自动传给从 Hub 打开的编辑器；可按自己的网络配置使用 TUN 或 GitHub 专用 Git 代理，恢复访问后点 Retry。

## Codex 安装

本机需要 Node.js 18+。安装仓库内的 Skill/CLI 插件：

```powershell
codex plugin marketplace add https://github.com/RetMnit/unity-bridge.git --ref v0.3.1
codex plugin add unity-bridge@unity-bridge-tools
```

升级已固定到旧标签的 marketplace 时，先运行 `codex plugin marketplace remove unity-bridge-tools`，再运行上述两条命令。旧来源未移除时，CLI 会拒绝用不同 ref 覆盖；安装后在新会话加载更新的 Skill。

新会话加载插件后，可以要求 Codex 检查场景、读取 Console、执行 Editor C# 或截图。它调用的是插件自带的普通 Node 程序，Desktop 和 Codex CLI 均可使用；不需要再启动一个 Codex agent。

也可克隆仓库直接运行，无需 `npm install`：

```powershell
git clone https://github.com/RetMnit/unity-bridge.git
cd unity-bridge
node plugins/unity-bridge/skills/unity-bridge/scripts/unity-bridge.mjs list
node plugins/unity-bridge/skills/unity-bridge/scripts/unity-bridge.mjs health --project <项目根目录>
node plugins/unity-bridge/skills/unity-bridge/scripts/unity-bridge.mjs exec --project <项目根目录> --file <代码片段.cs>
```

片段是同步 C# 方法体，使用 `return` 返回值。编译器为 Unity 自带 Roslyn，支持 C# 9；引用跟随当前 Editor/项目，框架 API 仍取决于项目兼容级别。返回 `byte[]` 时使用 `--output <新文件路径>` 保存，不把大段 base64 发给模型。

## DSH 安装

在承载 Unity preset 的 bundle 中，添加固定标签的依赖并安装：

```json
"dependencies": { "@retmnit/unity-bridge": "git+https://github.com/RetMnit/unity-bridge.git#v0.3.1" }
```

插件行使用 bundle 内的薄入口，再导出 `@retmnit/unity-bridge/dsh`；不复制公共客户端，也不记录开发机路径。完整入口、宿主重载方式和配置见 [DSH adapter](adapters/dsh/README.md)。

旧调用 `unity_execute({"code":"return 42;"})` 保持兼容。新增可选项目选择、等待预算、指定 ID 和二进制文件参数；管理工具支持 `list`、`health`、`status`、`wait`、`cancel`、`recent`。调用中断或等待超时后，用 `recent` 找回 ID 并查询。更新 bundle 后须让宿主重新加载插件，已有会话中的旧工具定义不会因磁盘文件变化自动更新。

## 可靠执行

- 自动发现项目、进程、端口和域实例；默认端口 6417，冲突时使用 6418–6450。多个工程打开时按 `--project` 明确选择。
- 每条命令都有 ID；同 ID/同内容去重，不同内容返回冲突。
- 提交与等待分离；超时或中断等待后用 `status <id>` 或 `wait <id>` 查结果，不能把超时当作未执行。取消客户端等待不自动取消 Editor 任务。
- 命令状态持久化到项目 `Library/UnityBridge/jobs`，域重载或编辑器重启后恢复状态，**不自动重放**。最新 128 条状态保留，历史淘汰后不再保证去重。
- 排队任务有期限，过期即取消；只有 queued 状态能取消。正在执行的任意 C# 无法安全强制中止。
- `hierarchy`、`logs`、`state`、`screenshot` 为固定操作，无需每次编译。截图要求启用图形并打开 Scene 视图。
- 同一片段缓存程序集，单域最多 128 个不同片段；达到限制后可通过菜单 Reload Domain 释放。主线程不会等待编译进程。

修改对象仍应正确使用 Undo、Prefab、dirty/save API；桥接不会自动保存场景、回滚部分执行或补充 Undo。

## 配置与范围

仅监听 `127.0.0.1`，拒绝浏览器 Origin 和非本地主机头。可选环境变量：

| 变量 | 用途 |
|---|---|
| `UNITY_BRIDGE_PORT` | 启动编辑器前指定固定端口，1024–65535 |
| `UNITY_BRIDGE_TOKEN` | 编辑器与客户端同时设置，启用 Bearer 认证；不要写进仓库 |
| `UNITY_BRIDGE_URL` | 客户端显式指定 localhost 地址 |

默认允许本机进程执行 C#，适用于受信任的个人开发环境。当前完整运行验证环境是 Windows / Unity 2022.3.62f3。缺少 Unity 自带 Roslyn/.NET host 时明确报错，不退回旧 CodeDom。

详细协议见 [docs/protocol.md](docs/protocol.md)，实测范围见 [docs/validation.md](docs/validation.md)；本地维护约定见 [AGENTS.md](AGENTS.md)。

## 验证

```powershell
npm test
# 下列测试只能对独立测试工程运行：会延迟主线程、触发域重载。
node tests/editor-smoke.mjs <独立测试工程>
node tests/recovery-smoke.mjs <独立测试工程>
```

这套仓库包含 Unity UPM 包、Codex 插件、DSH 原生适配器、零依赖 Node 客户端和测试。不包含个人 preset、项目素材、用户凭据、Unity 安装文件或测试工程缓存。

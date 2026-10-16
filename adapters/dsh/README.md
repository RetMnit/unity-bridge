# DSH adapter

把公共 Unity Bridge 客户端接进 **DeepSeek Harness（DSH）**：注册 `unity_execute` 与 `unity_bridge` 两个模型工具。协议与失败语义全部复用 `plugins/unity-bridge/skills/unity-bridge/scripts/client.mjs`，不复制客户端。

```text
adapters/dsh/unity-bridge.mjs   DSH 插件入口（name / inject / apply）+ 工具定义
adapters/dsh/bridge.mjs         Editor 解析、任务生命周期、durable 本地任务日志、二进制落盘、失败分类
tests/dsh-adapter.test.mjs      隔离 mock Editor 下的用例（不需要 Unity）
```

## 安装（DSH bundle，依赖固定 GitHub 标签）

在承载 preset 的 bundle 目录（例如 `~/.dsh/bundles/unity-preset/`）声明**标签固定的 Git 依赖**（HTTPS，避免 SSH 回退）：

```json
{
  "dependencies": { "@retmnit/unity-bridge": "git+https://github.com/RetMnit/unity-bridge.git#v0.3.0" }
}
```

```bash
cd <bundle-dir> && npm install      # 生成 node_modules；升级 = 改标签后重跑
```

bundle 里的插件文件只做解析与再导出（包导出 `./dsh` → `adapters/dsh/unity-bridge.mjs`）：

```js
// <bundle>/unity-bridge.mjs
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
const adapter = await import(pathToFileURL(require.resolve('@retmnit/unity-bridge/dsh')).href);
export const name = adapter.name;
export const inject = adapter.inject;
export function apply(ctx, config) { return adapter.apply(ctx, config); }
```

**升级依赖版本或修改插件代码后必须重启 Desktop Host。** 宿主 HMR 只监听三份配置（profile `package.json`、profile `cordis.patch.yml`、`~/.dsh/cordis.patch.yml`），不监听插件源码；已加载模块按 URL 命中 Node ESM 缓存，配置热重载只会用同一个模块对象重新 `apply()`（已实测：改配置后旧代码仍在生效、新工具名报 `unknown tool`）。preset 内的插件行另外被钉在会话启动时的 preset generation 上，运行中的会话无法换代码。

两道降级保护：适配器解析不到时，bundle 加载器注册一个说明安装步骤的占位 `unity_execute`；工具定义被宿主 schema 校验拒绝时，`apply()` 记录宿主原文并同样降级为占位实现，**不会让 preset 挂载失败**。

## 工具

### `unity_execute`

| 参数 | 说明 |
|---|---|
| `code`（必需） | 同步 C# 方法体；`return` 返回值，`Debug.Log*` 进日志 |
| `project` / `url` | 多开编辑器时选定目标（绝对工程根 / localhost origin） |
| `id` | 复用任务 ID：同 ID 同内容去重，不同内容 409 |
| `wait` | 默认 true；`false` 立即返回任务 ID，适合长写操作 |
| `timeoutSeconds` / `queueTimeoutSeconds` | 等待预算（默认 60） / 排队期限（默认 30） |
| `outputPath` / `overwrite` | 二进制结果落盘位置；已存在文件默认不覆盖 |

### `unity_bridge`

`action` = `list` | `health` | `status` | `wait` | `cancel` | `recent`，配 `id` / `project` / `url` / `timeoutSeconds` / `limit` / `outputPath` / `overwrite`。

`status` 与 `wait` 的 `outputPath`/`overwrite` 用来**保存已经产出的 `byte[]` 结果**（按 ID 重新读取任务，绝不重跑 C#）。`recent` 读取本地任务日志（默认 `~/.dsh/unity-bridge/jobs.jsonl`，可用 `UNITY_BRIDGE_JOURNAL` 或行配置覆盖），用于对话被中断后取回任务 ID。

## 结果语义

| 字段 | 含义 |
|---|---|
| `outcome` | `succeeded` / `failed` / `cancelled` / `interrupted` / `pending` / `unknown` / `rejected` / `not-submitted` |
| `state` | Editor 报告的原始状态；`unknown` 表示结果未知，**不等于失败** |
| `executionMayHaveOccurred` | true 时片段可能已经跑过；不要用新 ID 重发写操作 |
| `id` | 提交前就已生成并留痕；查询/取消失败时同样保留，配合 `url`/`projectPath` 定位 |
| `ok` | 这次桥接交互是否完成；提交结果未知时可为 true，查询失败时为 false。任务事实以 `outcome`/`state` 为准 |
| `artifactError` | 二进制结果**未**落盘的原因；命令结果本身不受影响，仍可按 ID 重新保存 |
| `logs` / `result` / `outputPath` / `byteLength` | 结构化日志、返回值、成功落盘路径与字节数 |

关键约定：

- **提交前留痕是硬条件**：ID 先以 durable 写方式落入本地任务日志，写不进去就**不发送**请求，返回 `not-submitted` 且 `executionMayHaveOccurred: false`。已执行之后的日志写失败只附提示，绝不改写命令结果。
- **等待超时不取消命令**，超预算即停（不会在后台继续查询）：`pending`/`unknown` 一律先查同一 ID，绝不换新 ID 重发。
- **查询/取消失败不等于命令没发生**：`status`/`wait`/`cancel` 失败会保留 `id`/`url`/`projectPath`，并明确说明该失败不能证明写入未执行。
- **保存失败与任务结果分开**：已有文件、非法 base64、超限等只体现在 `artifactError`，不会把无关文件当成产物，也不会把已成功的任务说成失败。
- 只有 `queued` 能被 `cancel` 取消；running/terminal 无法安全中止。

## 认证

`UNITY_BRIDGE_TOKEN` 环境变量（与 Editor 侧同值）即启用 Bearer 认证，客户端默认读取它；行配置的 `token` 会透传到 `discover`/`connect`/`submit`/`pollJob`/`request`，因此也可以只在适配器上配置（勿把令牌写进仓库）。认证失败只提示配置匹配的令牌，不建议关闭编辑器侧认证。

## 行配置（可选）

`project`、`url`、`token`、`directory`（发现目录）、`cwd`、`waitMs`、`queueTimeoutMs`、`outputDir`、`journalPath`、`log`。

## 测试

```bash
node --test tests/dsh-adapter.test.mjs   # 隔离 mock Editor，不需要 Unity
```

覆盖：注册 schema 属于宿主允许的 JSON Schema 子集、`{code}` 旧调用形状、单次提交 + 轮询、**提交前 durable 留痕**（日志不可写则不发送）、日志写失败不改写结果、等待超时保留 ID 且不出预算、提交响应丢失、调用中断、派发前取消、查询失败/404/409/断线都保留 ID 与 endpoint 且不谎称未执行、状态等待取消、选错工程拒连、项目身份头、二进制落盘与防覆盖、按 ID 重新保存、非法 base64、认证（环境变量与显式 token）、0.1.x 兼容端点、渲染截断、`recent` 取回 ID、注册被拒降级。

# HTTP protocol 2 / bridge 0.3.1

Transport is localhost HTTP with UTF-8 JSON and Content-Length; chunked request bodies are unsupported. Maximum header 16 KiB, body 1 MiB, 16 simultaneous connections, 32 nonterminal jobs. All Unity API calls and snippet execution occur on the Editor main thread. Compilation runs in a child process off the main thread.

## Endpoints

| Request | Response |
|---|---|
| `GET /api/health` | Version, project path/name, PID, port, instance ID, sampledUtc, cached Editor state, capabilities |
| `POST /api/jobs` | Submit `{id?, code?, operation?, limit?, queueTimeoutMs?}`; returns job immediately (normally HTTP 202) |
| `GET /api/jobs/{id}` | HTTP 200 with job, including terminal failures; 404 means unknown/evicted |
| `DELETE /api/jobs/{id}` | Cancel queued job only; HTTP 409 for a job already compiling/running/terminal |
| `POST /api/execute` | Legacy synchronous endpoint, waits up to 30 s; retains result/logs on success and error on failure |

Optional Authorization is `Bearer <UNITY_BRIDGE_TOKEN>` when configured before Editor startup. Health also requires auth in that mode. CLI clients must not send Origin. Discovery descriptors (without tokens) live under the OS per-user LocalApplicationData directory at `UnityBridge/editors/<pid>.json`; clients verify PID + instance ID against the live endpoint before selecting them. Health's Unity state is sampled on the main thread; sampledUtc indicates freshness while it is blocked.

The new CLI attaches `X-Unity-Bridge-Project` (base64-encoded UTF-8 normalized absolute project root) to job requests. The server rejects a different project before accepting the command, protecting against a port being reused by another Editor after discovery. Legacy clients may omit this header.

`operation` defaults to `eval`, requiring a nonempty `code`. Other operations are `state`, `hierarchy`, `logs`, `screenshot`; `limit` defaults to 100 and bounds text lines to 1..1000. Code is a synchronous C# method body. Framework API support follows the Editor's API compatibility level. `Task` results are rejected; asynchronous effects already started by the snippet are not cancelled.

## Job contract

```json
{
  "id": "client-generated-id",
  "state": "succeeded",
  "operation": "eval",
  "result": "42",
  "error": "",
  "logs": [],
  "executionMayHaveOccurred": true,
  "instanceId": "originating-domain-instance",
  "createdUtc": "UTC timestamp",
  "updatedUtc": "UTC timestamp",
  "fingerprint": "request SHA-256"
}
```

IDs contain 1..80 ASCII letters, digits, hyphens or underscores. Same ID + same operation/code/limit returns the existing job; different content returns 409. Queue/wait durations are not part of the content fingerprint. Clients generate and record IDs **before** submitting. A lost submission response must be resolved by querying the same ID, never by blindly repeating the write.

State transitions: queued → compiling → running → succeeded/failed. queued may become cancelled by cancellation, expiry or shutdown. A restart restores unfinished queued/compiling jobs as cancelled and running jobs as interrupted, with executionMayHaveOccurred=true. No restored job is replayed. A failed running snippet can have side effects; partial changes are not rolled back.

Queue timeout defaults to 30 s and is bounded to 1..300 s; checked again immediately before dequeue dispatch. Compilation has its own 30 s limit. Client wait timeout does not stop execution. Running status remains queryable even while a snippet blocks the main thread, provided the process/HTTP worker is alive.

Completed jobs/results are journaled under `Library/UnityBridge/jobs`. Only the latest 128 are retained; deduplication is bounded to retained records, not a permanent exactly-once guarantee. Deleting Library also deletes that history. Snippet source and compiler files are temporary under Library and cleaned after compilation. Loaded snippet assemblies remain until domain reload; identical code/reference sets reuse a cached assembly, with a maximum of 128 unique snippets per domain.

`byte[]` returns `@b64:<base64>`, up to 8 MiB of original bytes; CLI saves it with `--output` and refuses overwriting unless `--overwrite` is explicit. Logs retain up to 500 recent lines; each job captures up to 200 lines, each capped at 8192 characters. Logs include warnings, errors, exceptions and assertions.

## Clients and compatibility

Successful `POST /api/execute` still returns HTTP 200 with string `result` and string-array `logs`; failure remains HTTP 500 with `error`. Additional job fields are additive. If the 30 s synchronous wait ends while a job is pending, HTTP 500 includes its ID/state and an explicit instruction to query the job. It does **not** mark the command failed or cancel it.

The 0.3.0 DSH adapter preserves `unity_execute({code})` and uses the job API against protocol 2 Editors. It adds project selection, structured status/logs, binary spooling, host cancellation and a local pre-submission ID journal. `unity_bridge` provides list/health/status/wait/cancel/recent. See [adapter documentation](../adapters/dsh/README.md) for installation and reload behavior. Older DSH clients can still use `/api/execute`, but a client-side timeout can leave their outcome unknown.

The shared Node client exports `connect`, `discover`, `request`, `submit`, `pollJob`, `checkedJob` and `saveBinary` through `@retmnit/unity-bridge/client`. Requests accept an optional AbortSignal and token (default `UNITY_BRIDGE_TOKEN`). Aborting a wait stops requests promptly; it does not issue DELETE or replay a job. Unknown submission responses, malformed job replies and status-query errors preserve the original ID. Saving a completed binary result can fail independently of C# execution; recover by ID rather than executing again.

Both adapters are clients of the same local executor; the Unity package does not depend on either agent. Protocol 2 remains compatible with bridge 0.2.0.

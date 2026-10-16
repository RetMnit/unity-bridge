// DSH tool adapter for Unity Bridge.
//
// Registers two tools against `ctx.tools`:
//   unity_execute  — C# execution; the legacy { code } call shape still works
//   unity_bridge   — list / health / status / wait / cancel / recent
//
// Everything protocol-related lives in ./bridge.mjs, which wraps the shared
// public client (plugins/unity-bridge/skills/unity-bridge/scripts/client.mjs).
// This file only shapes arguments, output schemas and model-visible text, so the
// same adapter can be mounted by any DSH bundle or profile.
export { BridgeError, UnityBridge, JobJournal, isValidId, outcomeOf, explainFailure } from './bridge.mjs';
import { BridgeError, MAX_WAIT_MS, UnityBridge, clampMs, explainFailure, isValidId } from './bridge.mjs';

export const name = 'tool-unity-bridge';
export const inject = ['tools'];

const ACTIONS = ['list', 'health', 'status', 'wait', 'cancel', 'recent'];

/** Keys every tool value carries; keeps output validation deterministic. */
const BASE_PROPERTIES = {
  ok: { type: 'boolean', description: 'Whether the bridge interaction itself succeeded.' },
  status: { type: 'integer', description: 'HTTP status of the underlying call, or 0 when the transport failed.' },
  outcome: { type: 'string', description: 'succeeded | failed | cancelled | interrupted | pending | unknown | rejected | not-submitted.' },
  state: { type: 'string', description: 'Raw job state reported by the Editor, when known.' },
  id: { type: 'string', description: 'Job ID; the stable handle for later queries.' },
  result: { type: 'string', description: 'Command return value as text (binary payloads are saved to outputPath).' },
  error: { type: 'string', description: 'Failure or transport error message.' },
  logs: { type: 'array', items: { type: 'string' }, description: 'Unity console lines captured by the job.' },
  executionMayHaveOccurred: { type: 'boolean', description: 'True when the snippet may have run despite an unknown or failed outcome.' },
  url: { type: 'string', description: 'Editor endpoint that handled the call.' },
  projectPath: { type: 'string', description: 'Unity project root of the target Editor.' },
  outputPath: { type: 'string', description: 'Absolute path a binary result was successfully written to.' },
  byteLength: { type: 'integer', description: 'Size of a binary result in bytes, saved or not.' },
  artifactError: { type: 'string', description: 'Why a binary result could not be written to disk; the command result itself is unaffected.' },
  hint: { type: 'string', description: 'Recovery or follow-up guidance.' },
};

const BASE_REQUIRED = ['ok', 'status', 'outcome', 'state', 'id', 'result', 'error', 'logs', 'executionMayHaveOccurred'];

function execOutputSchema(extra = {}) {
  return {
    type: 'object',
    properties: { ...BASE_PROPERTIES, ...extra },
    required: BASE_REQUIRED,
    additionalProperties: false,
  };
}

function text(value) {
  return [{ type: 'text', text: value }];
}

function truncate(value, maxChars = 12_000, maxLines = 200) {
  const lines = String(value).split('\n');
  const kept = lines.slice(0, maxLines).join('\n');
  const clipped = kept.length > maxChars ? `${kept.slice(0, maxChars)}\n…[truncated]` : kept;
  return lines.length > maxLines ? `${clipped}\n…[truncated: ${lines.length - maxLines} more lines]` : clipped;
}

/**
 * Value for a call that could not be performed at all.
 *
 * `context` carries the caller's own facts (action, id, url, project) so a
 * failure that happens before the job layer can attach them — for example a
 * resolution failure — still reports the requested ID and endpoint. A failed
 * job query is reported as `unknown`, never as a rejected submission.
 */
export function rejected(error, context = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const state = typeof error?.state === 'string' ? error.state : '';
  const notSubmitted = state === 'not-submitted' || error?.notDispatched === true;
  const queryFailure = error?.queryFailure === true;
  const jobQuery = context.action === 'status' || context.action === 'wait' || context.action === 'cancel';
  const id = typeof error?.id === 'string' && error.id ? error.id : (typeof context.id === 'string' ? context.id : '');
  const unknownOutcome = state !== 'rejected' && (queryFailure || (jobQuery && Boolean(id)) || (state === 'unknown' && Boolean(id)));
  let outcome = 'rejected';
  if (notSubmitted) outcome = 'not-submitted';
  else if (unknownOutcome) outcome = 'unknown';
  const guidance = explainFailure(error, context);
  return {
    ok: false,
    status: Number.isInteger(error?.status) ? error.status : 0,
    outcome,
    state: state || (notSubmitted ? 'not-submitted' : unknownOutcome ? 'unknown' : ''),
    id,
    result: '',
    error: message,
    logs: [],
    executionMayHaveOccurred: notSubmitted ? false : (error?.executionMayHaveOccurred === true || unknownOutcome),
    url: (typeof error?.url === 'string' && error.url) || (typeof context.url === 'string' ? context.url : ''),
    projectPath: (typeof error?.projectPath === 'string' && error.projectPath) || (typeof context.project === 'string' ? context.project : ''),
    hint: notSubmitted
      ? 'Nothing was submitted or executed, so retrying is safe.'
      : joinGuidance(guidance, jobQuery && id ? 'This does not prove the command did not run: retry the same ID instead of repeating the write.' : ''),
  };
}

function joinGuidance(...parts) {
  return parts.filter(Boolean).join(' ');
}

/**
 * Model-facing guidance for a failure.
 *
 * `context.action` is the tool action (execute / status / wait / cancel /
 * health / list), which is what makes an HTTP 409 mean something specific.
 */
export function explain(error, context = {}) {
  return explainFailure(error, context);
}

/** Model-visible text for a job value. */
export function renderJob(action, value) {
  const header = [
    action ? `${action}:` : 'unity_execute:',
    value.outcome || 'unknown',
    value.id ? `job ${value.id}` : '',
    value.state && value.state !== value.outcome ? `state=${value.state}` : '',
    value.projectPath ? `project=${value.projectPath}` : '',
  ].filter(Boolean).join(' ');

  const body = [];
  if (value.outcome === 'not-submitted') body.push('nothing was submitted, so retrying is safe.');
  if (value.result) body.push(value.result);
  if (Array.isArray(value.logs) && value.logs.length) body.push(value.logs.join('\n'));
  if (value.error) body.push(`error: ${value.error}`);
  if (value.artifactError) body.push(`binary artifact NOT written: ${value.artifactError}`);
  if (value.outputPath) body.push(`binary saved: ${value.outputPath} (${value.byteLength ?? 0} bytes)`);
  if (value.hint) body.push(`note: ${value.hint}`);
  return text(truncate([header, ...body].join('\n')));
}

function renderEditors(value) {
  if (!Array.isArray(value.editors) || value.editors.length === 0) {
    return text('list: no Unity Editor with Unity Bridge is answering.\nnote: open the project with the Unity Bridge package installed, or pass `project`/`url` explicitly.');
  }
  const hint = value.hint ? [`note: ${value.hint}`] : [];
  return text(truncate([`list: ${value.editors.length} Editor(s)`, ...value.editors.map((line) => `- ${line}`), ...hint].join('\n')));
}

function renderRecent(value) {
  const entries = Array.isArray(value.entries) ? value.entries : [];
  if (entries.length === 0) return text(`recent: no locally recorded jobs (${value.journalPath || 'journal empty'}).`);
  return text(truncate([`recent: last ${entries.length} local job record(s)`, ...entries.map((line) => `- ${line}`), value.hint ? `note: ${value.hint}` : ''].filter(Boolean).join('\n')));
}

/** `unity_execute` — unchanged call shape for existing sessions. */
export function unityExecuteTool(bridge) {
  return {
    name: 'unity_execute',
    description:
      'Execute C# inside the running Unity Editor through Unity Bridge (protocol 2 job API; default 127.0.0.1:6417, ' +
      'discovered automatically when several Editors are open). `code` is a synchronous method body compiled by Unity\'s ' +
      'own Roslyn (C# 9; framework APIs follow the project compatibility level): use `return <expr>;` for a value and ' +
      'Debug.Log* for logs. A `byte[]` result is written to a file and reported as outputPath instead of dumping base64. ' +
      'Every call gets a job ID that is recorded before submission, so a timeout or interruption is NOT a failure — ' +
      'query unity_bridge {"action":"status","id":"…"} instead of repeating a write.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Synchronous C# method body. `return` yields the result; Debug.Log* becomes logs.' },
        project: { type: 'string', description: 'Absolute Unity project root to target when several Editors are open.' },
        url: { type: 'string', description: 'Explicit localhost origin, e.g. http://127.0.0.1:6417.' },
        id: { type: 'string', description: 'Reuse a specific job ID (same ID + same content deduplicates; different content returns 409).' },
        wait: { type: 'boolean', description: 'Wait for the result. Default true; false returns the job ID immediately for long writes.' },
        timeoutSeconds: { type: 'integer', description: `Wait budget in seconds, 1..${MAX_WAIT_MS / 1000} (default 60). Reaching it never cancels the command.` },
        queueTimeoutSeconds: { type: 'integer', description: 'Queue deadline in seconds, 1..300 (default 30); an expired queued job is cancelled.' },
        outputPath: { type: 'string', description: 'File to write a binary result to. Defaults to a temp file; an existing file is never replaced unless overwrite is true.' },
        overwrite: { type: 'boolean', description: 'Allow replacing an existing outputPath.' },
      },
      required: ['code'],
      additionalProperties: false,
    },
    output: { schema: execOutputSchema(), render: (args, value) => renderJob('unity_execute', value) },
    async execute(args, exec) {
      const code = args?.code;
      if (typeof code !== 'string' || code.trim() === '') {
        return rejected(new BridgeError('`code` must be a non-empty C# method body.', { state: 'rejected', executionMayHaveOccurred: false }), { action: 'execute' });
      }
      try {
        return await bridge.exec({
          code,
          project: args.project,
          url: args.url,
          id: args.id,
          wait: args.wait !== false,
          waitMs: clampMs(args.timeoutSeconds === undefined ? undefined : args.timeoutSeconds * 1000, { fallback: bridge.options.waitMs }),
          queueTimeoutMs: clampMs(args.queueTimeoutSeconds === undefined ? undefined : args.queueTimeoutSeconds * 1000, { fallback: bridge.options.queueTimeoutMs }),
          outputPath: args.outputPath,
          overwrite: args.overwrite === true,
          signal: exec?.signal,
        });
      } catch (error) {
        return rejected(error, { action: 'execute', id: args.id, url: args.url, project: args.project });
      }
    },
  };
}

/** `unity_bridge` — one management tool instead of one tool per verb. */
export function unityBridgeTool(bridge) {
  return {
    name: 'unity_bridge',
    description:
      'Manage Unity Bridge Editors and jobs. Actions: ' +
      '`list` (every Editor answering discovery), `health` (version, project path, PID, instance, protocol), ' +
      '`status` (one job by ID), `wait` (poll one job until terminal or the budget ends), `cancel` (only a queued job), ' +
      '`recent` (locally recorded IDs — use it to recover an ID after an interrupted turn). ' +
      'status and wait accept outputPath/overwrite to save an already-produced `byte[]` result without re-running the C#. ' +
      'A timeout or interruption is not a failure: query by ID and never resubmit a write with a new ID.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ACTIONS, description: 'Operation to perform.' },
        id: { type: 'string', description: 'Job ID for status, wait and cancel.' },
        project: { type: 'string', description: 'Absolute Unity project root to target when several Editors are open.' },
        url: { type: 'string', description: 'Explicit localhost origin, e.g. http://127.0.0.1:6417.' },
        timeoutSeconds: { type: 'integer', description: `Wait budget for the wait action, 1..${MAX_WAIT_MS / 1000} (default 60).` },
        limit: { type: 'integer', description: 'Number of local journal records for the recent action, 1..100 (default 20).' },
        outputPath: { type: 'string', description: 'Save an existing binary result to this file (status/wait) instead of leaving it unsaved.' },
        overwrite: { type: 'boolean', description: 'Allow replacing an existing outputPath.' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: execOutputSchema({
        editors: { type: 'array', items: { type: 'string' }, description: 'One line per discovered Editor (list).' },
        entries: { type: 'array', items: { type: 'string' }, description: 'Formatted local journal records (recent).' },
        journalPath: { type: 'string', description: 'Journal file backing the recent action.' },
        version: { type: 'string', description: 'Unity version reported by health.' },
        bridgeVersion: { type: 'string', description: 'Bridge package version reported by health.' },
        protocol: { type: 'string', description: 'Protocol revision reported by health.' },
      }),
      render(args, value) {
        if (args?.action === 'list') return renderEditors(value);
        if (args?.action === 'recent') return renderRecent(value);
        if (args?.action === 'health') {
          const lines = [
            `unity_bridge health: ${value.result || 'unknown'}`,
            value.projectPath ? `project: ${value.projectPath}` : '',
            value.url ? `endpoint: ${value.url}` : '',
            value.error ? `error: ${value.error}` : '',
            value.hint ? `note: ${value.hint}` : '',
          ].filter(Boolean);
          return text(truncate(lines.join('\n')));
        }
        return renderJob(`unity_bridge ${args?.action ?? ''}`.trim(), value);
      },
    },
    async execute(args, exec) {
      const action = args?.action;
      const signal = exec?.signal;
      if (!ACTIONS.includes(action)) return rejected(new BridgeError(`action must be one of ${ACTIONS.join(', ')}.`, { state: 'rejected', executionMayHaveOccurred: false }), { action: String(action) });
      try {
        if (action === 'list') {
          const editors = await bridge.list({ signal });
          return {
            ...ok(),
            editors: editors.map((editor) => `${editor.projectPath ?? 'unknown project'}  ${editor.url}  pid=${editor.pid ?? '?'} instance=${editor.instanceId ?? '?'} unity=${editor.unity ?? '?'} protocol=${editor.protocol ?? '1'}`),
            hint: editors.length > 1 ? 'Pass `project` or `url` to select exactly one Editor.' : '',
          };
        }
        if (action === 'recent') {
          const limit = Number.isInteger(args.limit) ? Math.min(Math.max(args.limit, 1), 100) : 20;
          const entries = await bridge.recent(limit);
          return {
            ...ok(),
            entries: entries.map((entry) => `${entry.at ?? ''} ${entry.phase ?? ''} ${entry.id ?? ''} ${entry.state ?? ''} ${entry.projectPath ?? ''} ${entry.error ?? ''}`.trim()),
            journalPath: bridge.options.journal.file,
            hint: 'Use status with the recorded ID to learn the real outcome.',
          };
        }
        if (action === 'health') {
          const endpoint = await bridge.health({ project: args.project, url: args.url, signal });
          return {
            ...ok(),
            url: endpoint.url,
            projectPath: endpoint.projectPath ?? '',
            state: endpoint.state ?? '',
            version: endpoint.unity ?? '',
            bridgeVersion: endpoint.bridge ?? '',
            protocol: String(endpoint.protocol ?? '1'),
            result: `Unity ${endpoint.unity ?? '?'} / bridge ${endpoint.bridge ?? '?'} / protocol ${endpoint.protocol ?? '1'}`,
            hint: endpoint.protocol === '2' ? '' : 'This Editor predates protocol 2: only the legacy synchronous endpoint is available.',
          };
        }
        if (!isValidId(args.id)) {
          return rejected(new BridgeError(`${action} requires a valid job ID in \`id\`.`, { state: 'rejected', executionMayHaveOccurred: false }), { action, id: typeof args.id === 'string' ? args.id : '', url: args.url, project: args.project });
        }
        if (action === 'status') {
          return await bridge.status({ id: args.id, project: args.project, url: args.url, outputPath: args.outputPath, overwrite: args.overwrite === true, signal });
        }
        if (action === 'wait') {
          return await bridge.wait({
            id: args.id,
            project: args.project,
            url: args.url,
            waitMs: clampMs(args.timeoutSeconds === undefined ? undefined : args.timeoutSeconds * 1000, { fallback: bridge.options.waitMs }),
            outputPath: args.outputPath,
            overwrite: args.overwrite === true,
            signal,
          });
        }
        return await bridge.cancel({ id: args.id, project: args.project, url: args.url, signal });
      } catch (error) {
        return rejected(error, { action, id: args.id, url: args.url, project: args.project });
      }
    },
  };
}

function ok() {
  return {
    ok: true,
    status: 200,
    outcome: 'succeeded',
    state: '',
    id: '',
    result: '',
    error: '',
    logs: [],
    executionMayHaveOccurred: false,
    url: '',
    projectPath: '',
  };
}

/** Instantiate the tools (used by DSH and by tests). */
export function createTools(bridge = new UnityBridge()) {
  return [unityExecuteTool(bridge), unityBridgeTool(bridge)];
}

/**
 * Minimal `unity_execute` used when the real tools cannot be registered.
 *
 * The host validates a tool definition when it is registered; a rejection would
 * otherwise fail this plugin's fiber and can take the whole preset down with it.
 * Degrading to a self-explaining placeholder keeps every other tool in the
 * session working.
 */
export function fallbackExecuteTool(message) {
  return {
    name: 'unity_execute',
    description: `Unavailable. ${message}`,
    parameters: {
      type: 'object',
      properties: { code: { type: 'string', description: 'C# method body (currently unavailable).' } },
      required: ['code'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: { ok: { type: 'boolean' }, status: { type: 'integer' }, result: { type: 'string' }, error: { type: 'string' } },
        required: ['ok', 'status', 'result', 'error'],
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: value.error }],
    },
    async execute() {
      return { ok: false, status: 0, result: '', error: message };
    },
  };
}

/** DSH plugin entry. */
export function apply(ctx, config = {}) {
  const bridge = new UnityBridge(config);
  const registered = [];
  for (const tool of createTools(bridge)) {
    try {
      ctx.tools.register(tool);
      registered.push(tool.name);
    } catch (error) {
      console.error(`[unity-bridge] could not register ${tool.name}: ${error?.message ?? error}`);
    }
  }
  if (!registered.includes('unity_execute')) {
    const message = `unity_execute could not be registered in this host: ${registered.length ? 'registration rejected' : 'no tool was accepted'}. See the DSH log for the host's validation message.`;
    try {
      ctx.tools.register(fallbackExecuteTool(message));
    } catch (error) {
      console.error(`[unity-bridge] fallback registration also failed: ${error?.message ?? error}`);
    }
  }
  return bridge;
}

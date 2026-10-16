// DSH-side bridge layer for Unity Bridge protocol 2.
//
// This module owns everything a DSH tool needs on top of the shared client:
// endpoint/project resolution, a durable local job journal, the job lifecycle
// (submit / status / wait / cancel), unknown-outcome preservation, and binary
// result spooling. It imports the public client instead of reimplementing the
// wire protocol, so the Codex CLI and DSH cannot drift apart.
//
// Failure taxonomy kept here (mirrored in the tool output):
//   not-submitted  nothing reached the Editor (journal unwritable, cancelled
//                  before dispatch); retrying the same ID is safe
//   rejected       the Editor refused the submission before accepting it
//   pending        accepted, not terminal yet (queued/compiling/running)
//   unknown        accepted, outcome not knowable right now (transport loss,
//                  unusable reply, evicted ID); the ID stays the handle
//   succeeded/failed/cancelled/interrupted  terminal states
import { open, mkdir, readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  BridgeError,
  checkedJob,
  connect,
  discover,
  pollJob,
  request,
  saveBinary,
  submit,
  terminal,
} from '../../plugins/unity-bridge/skills/unity-bridge/scripts/client.mjs';

export { BridgeError, terminal };

/** Protocol revision this adapter targets; earlier servers use /api/execute. */
export const PROTOCOL = '2';
export const DEFAULT_WAIT_MS = 60_000;
export const DEFAULT_QUEUE_TIMEOUT_MS = 30_000;
export const MAX_WAIT_MS = 300_000;
export const MAX_SNIPPET_BYTES = 900_000;

/** Job IDs accepted by the server: 1..80 of A-Z a-z 0-9 - _ */
export function isValidId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(value);
}

export function newJobId() {
  return randomUUID();
}

export function clampMs(value, { fallback, max = MAX_WAIT_MS }) {
  if (value === undefined || value === null || value === '') return fallback;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 1) throw new BridgeError(`Timeout must be a positive number of milliseconds (got ${value}).`);
  return Math.min(Math.round(ms), max);
}

/** Outcome vocabulary exposed to DSH; never a single overloaded boolean. */
export function outcomeOf(state) {
  if (state === 'succeeded') return 'succeeded';
  if (state === 'failed' || state === 'cancelled' || state === 'interrupted') return state;
  if (state === 'queued' || state === 'compiling' || state === 'running') return 'pending';
  if (state === 'not-submitted') return 'not-submitted';
  if (state === 'rejected') return 'rejected';
  return 'unknown';
}

/**
 * Append-only local record of submitted jobs.
 *
 * The Editor keeps the authoritative job state, but a tool call can end before
 * its result reaches the model (turn cancelled, wait budget exhausted, DSH
 * stopped, transport lost). The ID is therefore written *before* submitting, by
 * a call that must succeed: `record()` throws when the entry cannot be
 * persisted, and the adapter refuses to send the write in that case. Facts
 * learned afterwards use `recordBestEffort()`, because a journal failure must
 * never rewrite an outcome that already happened.
 */
export class JobJournal {
  constructor(file = process.env.UNITY_BRIDGE_JOURNAL || path.join(homedir(), '.dsh', 'unity-bridge', 'jobs.jsonl')) {
    this.file = file;
  }

  /** Durable append. Throws when the entry could not be persisted. */
  async record(entry) {
    await mkdir(path.dirname(this.file), { recursive: true });
    const file = await open(this.file, 'a');
    try {
      await file.writeFile(`${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
      await file.sync();
    } finally { await file.close(); }
  }

  /** Post-execution append: never throws, reports the failure instead. */
  async recordBestEffort(entry) {
    try {
      await this.record(entry);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error?.message ?? String(error) };
    }
  }

  async recent(limit = 20) {
    let text;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
    return text
      .split('\n')
      .filter(Boolean)
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      });
  }
}

function defaultOutputFile(id, job, outputDir) {
  const extension = job?.operation === 'screenshot' ? '.png' : '.bin';
  return path.join(outputDir || path.join(tmpdir(), 'unity-bridge'), `${id}${extension}`);
}

/** Decoded byte length of an `@b64:` result, or undefined when unusable. */
export function binaryLength(result) {
  if (typeof result !== 'string' || !result.startsWith('@b64:')) return undefined;
  const encoded = result.slice(5);
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return undefined;
  return Buffer.from(encoded, 'base64').length;
}

/**
 * Model-facing guidance for a failure.
 *
 * `context.action` is the tool action (execute / status / wait / cancel /
 * health / list), which is what makes an HTTP 409 mean something specific.
 * A failed query is never described as evidence that the write did not run.
 */
export function explainFailure(error, context = {}) {
  const status = Number.isInteger(error?.status) && error.status > 0 ? error.status : undefined;
  const message = error?.message ?? '';
  const action = context.action ?? '';
  const jobQuery = action === 'status' || action === 'wait' || action === 'cancel';

  if (error?.queryFailure) {
    if (status === 409 && action === 'cancel') {
      return 'The job is not queued: only a queued job can be cancelled. A compiling/running/terminal job cannot be stopped safely, and it may already have executed.';
    }
    if (status === 404) {
      return 'Unknown or evicted job ID (only the latest 128 jobs are retained). This query cannot recover the outcome, and it does not prove that the command did not run.';
    }
    return 'The query itself failed; that does not prove the command did not run. Retry the same ID after checking the Editor, and do not repeat the write.';
  }
  if (error?.aborted) return 'The call was interrupted. If a job ID was recorded, query it before repeating any write.';
  if (status === 401) return 'The Editor requires authentication: configure a matching Bearer token for the DSH process (UNITY_BRIDGE_TOKEN, or the adapter `token` option) and for the Editor.';
  if (status === 403) {
    return /origin/i.test(message)
      ? 'The Editor refused this request because of its Origin header (browser-style callers are rejected). Use the DSH adapter or the CLI over plain localhost HTTP.'
      : 'The Editor refused the request (HTTP 403): verify that the token matches the one the Editor was started with and that the target project is the expected one.';
  }
  if (status === 404) {
    return jobQuery
      ? 'Unknown or evicted job ID (only the latest 128 jobs are retained); this query cannot recover the outcome.'
      : 'The Editor has no route for this request (HTTP 404): the installed package is probably older than the job API.';
  }
  if (status === 409) {
    if (action === 'cancel') return 'The job is not queued: only a queued job can be cancelled. A compiling/running/terminal job cannot be stopped safely and may already have executed.';
    if (/project|guard|mismatch|header/i.test(message)) return 'Project mismatch: this Editor rejects commands for another project (the X-Unity-Bridge-Project guard). Pass the `project` root or `url` of the intended Editor.';
    if (/content|fingerprint|different|conflict/i.test(message)) return 'ID conflict: this job ID exists with different content. Reuse the identical request, or submit a new command under a new ID.';
    return 'HTTP 409: either this job ID already exists with different content, or the Editor rejected the project guard. Check the ID and the target project.';
  }
  if (/Multiple Editors match/.test(message)) return 'Several Editors are running. Pass `project` (absolute project root) or `url` to pick one.';
  if (/does not match/.test(message)) return 'That endpoint serves a different Unity project. Pass the `project` root or `url` of the intended Editor.';
  if (/No matching Editor|No Unity editor/i.test(message)) return 'No Editor answered. Open the Unity project with the Unity Bridge package installed, then retry.';
  if (/protocol 2/.test(message)) return 'Update the Unity package to 0.2.0 or newer; job queries need protocol 2.';
  if (error?.transport) return 'The Editor did not answer. Check that Unity is open with the bridge running.';
  return '';
}

/**
 * Operations shared by every DSH tool: resolve the target Editor, run or query
 * a job, and spool binary results to disk.
 */
export class UnityBridge {
  constructor(options = {}) {
    this.options = {
      url: options.url,
      project: options.project,
      token: options.token,
      directory: options.directory,
      cwd: options.cwd,
      outputDir: options.outputDir,
      waitMs: options.waitMs ?? DEFAULT_WAIT_MS,
      queueTimeoutMs: options.queueTimeoutMs ?? DEFAULT_QUEUE_TIMEOUT_MS,
      journal: options.journal instanceof JobJournal ? options.journal : new JobJournal(options.journalPath),
      log: typeof options.log === 'function' ? options.log : (message) => console.error(`[unity-bridge] ${message}`),
    };
    this.cache = new Map();
  }

  invalidate() {
    this.cache.clear();
  }

  /** Resolve (and briefly cache) the Editor endpoint for a project. */
  async resolve({ project, url, refresh = false, signal } = {}) {
    const wantedProject = project ?? this.options.project;
    const wantedUrl = url ?? this.options.url;
    const key = `${wantedUrl ?? ''}\u0000${wantedProject ?? ''}`;
    if (!refresh && this.cache.has(key)) return this.cache.get(key);
    try {
      const endpoint = await connect({
        url: wantedUrl,
        project: wantedProject,
        cwd: this.options.cwd,
        directory: this.options.directory,
        token: this.options.token,
        signal,
      });
      this.cache.set(key, endpoint);
      return endpoint;
    } catch (error) {
      this.invalidate();
      throw error;
    }
  }

  /** Every Editor currently publishing a discovery descriptor and answering health. */
  async list({ signal } = {}) {
    return discover({ directory: this.options.directory, signal, token: this.options.token });
  }

  async health({ project, url, signal } = {}) {
    const endpoint = await this.resolve({ project, url, refresh: true, signal });
    this.options.log(`health ${endpoint.url} project=${endpoint.projectPath ?? 'unknown'} protocol=${endpoint.protocol ?? '1'}`);
    return endpoint;
  }

  /**
   * Submit `code` as a job and (optionally) wait for it.
   *
   * The pre-submission journal entry is durable: when it cannot be written, no
   * request is sent at all and the caller gets `not-submitted` with
   * `executionMayHaveOccurred: false`.
   */
  async exec(input = {}) {
    const {
      code,
      project,
      url,
      id,
      wait = true,
      waitMs,
      queueTimeoutMs,
      outputPath,
      overwrite = false,
      signal,
      operation = 'eval',
      limit,
    } = input;

    if (typeof code !== 'string' || code.trim() === '') throw new BridgeError('`code` must be a non-empty C# method body.', { state: 'rejected', executionMayHaveOccurred: false });
    if (Buffer.byteLength(code, 'utf8') > MAX_SNIPPET_BYTES) throw new BridgeError('Snippet exceeds the 900 KB request limit.', { state: 'rejected', executionMayHaveOccurred: false });

    const jobId = id === undefined ? newJobId() : id;
    if (!isValidId(jobId)) throw new BridgeError('Job IDs must be 1..80 characters of A-Z, a-z, 0-9, "-" or "_".', { state: 'rejected', executionMayHaveOccurred: false });

    const budgetMs = clampMs(waitMs, { fallback: this.options.waitMs });
    const queueMs = clampMs(queueTimeoutMs, { fallback: this.options.queueTimeoutMs });
    const endpoint = await this.resolve({ project, url, signal });

    try {
      await this.options.journal.record({
        phase: 'submit',
        id: jobId,
        state: 'unknown',
        outcome: 'unknown',
        url: endpoint.url,
        projectPath: endpoint.projectPath ?? '',
        executionMayHaveOccurred: true,
        reason: 'recorded before submission',
      });
    } catch (error) {
      const message = `Job journal is not writable (${this.options.journal.file}): ${error?.message ?? error}. Nothing was sent to the Editor.`;
      this.options.log(message);
      return {
        ok: false,
        status: 0,
        outcome: 'not-submitted',
        state: 'not-submitted',
        id: jobId,
        result: '',
        error: message,
        logs: [],
        executionMayHaveOccurred: false,
        url: endpoint.url,
        projectPath: typeof endpoint.projectPath === 'string' ? endpoint.projectPath : '',
        hint: 'Nothing was submitted, so retrying the same ID is safe once the journal path is writable (adapter config journalPath or UNITY_BRIDGE_JOURNAL).',
      };
    }
    this.options.log(`submit job ${jobId} -> ${endpoint.url} (${endpoint.projectPath ?? 'unknown project'})`);

    if (endpoint.protocol !== PROTOCOL) {
      return this.#legacyExec({ endpoint, code, id: jobId, waitMs: budgetMs, outputPath, overwrite, signal });
    }

    let job;
    try {
      job = await submit(
        endpoint.url,
        { operation, code, limit, queueTimeoutMs: queueMs },
        { id: jobId, wait, timeoutMs: budgetMs, projectPath: endpoint.projectPath, signal, token: this.options.token },
      );
    } catch (error) {
      return this.#submissionFailure({ error, endpoint, id: jobId, outputPath, overwrite });
    }
    return this.finalize({ job, endpoint, id: jobId, outputPath, overwrite });
  }

  async status({ id, project, url, outputPath, overwrite = false, signal } = {}) {
    if (!isValidId(id)) throw new BridgeError('A valid job ID is required.', { id, state: 'rejected', executionMayHaveOccurred: false });
    const endpoint = await this.resolve({ project, url, signal });
    this.#requireProtocol(endpoint, 'Querying job status');
    let job;
    try {
      job = checkedJob(await request(endpoint.url, `/api/jobs/${encodeURIComponent(id)}`, {
        timeoutMs: 10_000,
        token: this.options.token,
        projectPath: endpoint.projectPath,
        signal,
      }), id);
    } catch (error) {
      throw this.#queryFailure(error, { id, endpoint, what: `status query for job ${id}` });
    }
    return this.finalize({ job, endpoint, id, outputPath, overwrite });
  }

  async wait({ id, project, url, waitMs, outputPath, overwrite = false, signal } = {}) {
    if (!isValidId(id)) throw new BridgeError('A valid job ID is required.', { id, state: 'rejected', executionMayHaveOccurred: false });
    const endpoint = await this.resolve({ project, url, signal });
    this.#requireProtocol(endpoint, 'Waiting for a job');
    const budgetMs = clampMs(waitMs, { fallback: this.options.waitMs });
    let job;
    try {
      job = await pollJob(endpoint.url, id, { timeoutMs: budgetMs, projectPath: endpoint.projectPath, signal, token: this.options.token });
    } catch (error) {
      // A failed or unusable query is never evidence that the write did not run.
      if (error?.status === 404 || error?.invalidResponse === true || (error?.exitCode !== 2 && error?.status !== undefined)) {
        throw this.#queryFailure(error, { id, endpoint, what: `wait for job ${id}` });
      }
      if (error?.exitCode !== 2) throw this.#queryFailure(error, { id, endpoint, what: `wait for job ${id}` });
      const state = typeof error.state === 'string' && error.state ? error.state : 'unknown';
      // The wait budget ended (or the caller interrupted): stop here, do not keep
      // querying in the background, and never exceed the requested budget.
      if (error.transport || error.status === undefined || error.status >= 500) this.invalidate();
      const value = this.#pendingValue({
        endpoint,
        id,
        state,
        interrupted: Boolean(error.aborted),
        executionMayHaveOccurred: error.executionMayHaveOccurred ?? true,
        error: error.message,
      });
      value.hint = [value.hint, await this.#note({ phase: 'pending', id, state, outcome: value.outcome, url: endpoint.url, executionMayHaveOccurred: true })].filter(Boolean).join(' ');
      return value;
    }
    return this.finalize({ job, endpoint, id, outputPath, overwrite });
  }

  async cancel({ id, project, url, signal } = {}) {
    if (!isValidId(id)) throw new BridgeError('A valid job ID is required.', { id, state: 'rejected', executionMayHaveOccurred: false });
    const endpoint = await this.resolve({ project, url, signal });
    this.#requireProtocol(endpoint, 'Cancelling a job');
    let job;
    try {
      job = checkedJob(await request(endpoint.url, `/api/jobs/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        timeoutMs: 10_000,
        token: this.options.token,
        projectPath: endpoint.projectPath,
        signal,
      }), id);
    } catch (error) {
      throw this.#queryFailure(error, { id, endpoint, what: `cancel request for job ${id}` });
    }
    await this.#note({ phase: 'cancel', id, state: job.state ?? 'cancelled', url: endpoint.url, executionMayHaveOccurred: job.executionMayHaveOccurred === true });
    return this.finalize({ job, endpoint, id, outputPath: undefined, overwrite: false });
  }

  async recent(limit = 20) {
    return this.options.journal.recent(limit);
  }

  #requireProtocol(endpoint, what) {
    if (endpoint.protocol !== PROTOCOL) {
      throw new BridgeError(`${what} requires Unity Bridge protocol 2 (package 0.2.0+); ${endpoint.url} reports protocol ${endpoint.protocol ?? '1'}. Update the Unity package.`, { state: 'rejected', executionMayHaveOccurred: false });
    }
  }

  /**
   * Wrap a failed status/wait/cancel exchange. The job ID, endpoint and project
   * survive, and the result is explicitly marked as a query failure: not being
   * able to read a job says nothing about whether it ran.
   */
  #queryFailure(error, { id, endpoint, what }) {
    this.invalidate();
    return new BridgeError(`${what} failed: ${error?.message ?? error}`, {
      id,
      state: 'unknown',
      status: Number.isInteger(error?.status) ? error.status : 0,
      url: endpoint.url,
      projectPath: endpoint.projectPath ?? '',
      queryFailure: true,
      transport: error?.transport === true,
      invalidResponse: error?.invalidResponse === true,
      aborted: error?.aborted === true,
      executionMayHaveOccurred: true,
    });
  }

  /** Append a post-execution fact; never allowed to change the outcome. */
  async #note(entry) {
    const result = await this.options.journal.recordBestEffort(entry);
    return result.ok
      ? ''
      : `Job journal could not be updated (${this.options.journal.file}): ${result.error}. The command outcome above is unaffected; the Editor keeps the authoritative state for this ID.`;
  }

  /** Attach the resolved binary payload, if any, to a job value. */
  async finalize({ job, endpoint, id, outputPath, overwrite }) {
    const spooled = await this.#spoolBinary(job, { id, outputPath, overwrite });
    const saved = spooled.job;
    const state = typeof saved.state === 'string' && saved.state ? saved.state : 'unknown';
    const outcome = outcomeOf(state);
    const value = {
      ok: outcome === 'succeeded' || outcome === 'pending' || outcome === 'unknown',
      status: 200,
      outcome,
      state,
      id: typeof saved.id === 'string' && saved.id ? saved.id : id,
      result: typeof saved.result === 'string' ? saved.result : '',
      error: typeof saved.error === 'string' ? saved.error : '',
      logs: Array.isArray(saved.logs) ? saved.logs.map(String) : [],
      executionMayHaveOccurred: saved.executionMayHaveOccurred === true,
      url: endpoint.url,
      projectPath: typeof endpoint.projectPath === 'string' ? endpoint.projectPath : '',
    };
    if (spooled.outputPath) {
      value.outputPath = spooled.outputPath;
      value.byteLength = Number.isInteger(saved.byteLength) ? saved.byteLength : 0;
    } else if (Number.isInteger(saved.byteLength)) {
      value.byteLength = saved.byteLength;
    }
    if (spooled.artifactError) {
      value.artifactError = spooled.artifactError;
      value.hint = `The command result is intact and still queryable by ID, but its binary payload was NOT written to disk: ${spooled.artifactError}. Re-save it with unity_bridge {"action":"status","id":"${value.id}","outputPath":"<new path>"} (or overwrite: true) — that re-reads the stored result and never re-runs the C#.`;
    }
    if (outcome === 'pending' || outcome === 'unknown') {
      value.hint = joinHints(value.hint, `Outcome not final. Query unity_bridge {"action":"status","id":"${value.id}"} before repeating any write; never resubmit with a new ID.`);
    } else if (outcome === 'cancelled') {
      value.hint = joinHints(value.hint, 'Cancelled. No automatic replay is scheduled.');
    } else if (outcome === 'interrupted') {
      value.hint = joinHints(value.hint, 'Execution was interrupted. Inspect project state before retrying; changes may be partial.');
    } else if (outcome !== 'succeeded') {
      value.hint = joinHints(value.hint, 'Terminal failure. Inspect `error` and the Editor console; a running snippet is not rolled back.');
    }
    if (saved.hint) value.hint = joinHints(value.hint, saved.hint);
    value.hint = joinHints(value.hint, await this.#note({
      phase: outcome === 'unknown' ? 'unknown' : 'result',
      id: value.id,
      state,
      outcome,
      url: endpoint.url,
      projectPath: value.projectPath,
      executionMayHaveOccurred: value.executionMayHaveOccurred,
      error: value.error.slice(0, 500),
    }));
    if (!value.hint) delete value.hint;
    return value;
  }

  #pendingValue({ endpoint, id, state, executionMayHaveOccurred = true, interrupted = false, error }) {
    const value = {
      ok: true,
      status: 202,
      outcome: outcomeOf(state),
      state,
      id,
      result: '',
      error: typeof error === 'string' ? error : '',
      logs: [],
      executionMayHaveOccurred,
      url: endpoint.url,
      projectPath: typeof endpoint.projectPath === 'string' ? endpoint.projectPath : '',
      hint: interrupted
        ? `The tool call was interrupted after job ${id} was accepted; the command was NOT cancelled and may still be running. Query unity_bridge {"action":"status","id":"${id}"} before doing anything else.`
        : `Outcome not final: the job is ${state === 'unknown' ? 'in an unknown state' : state} and may already be running or finished. Query unity_bridge {"action":"status","id":"${id}"} instead of resubmitting.`,
    };
    return value;
  }

  /** Turn a lost or interrupted submission into a recoverable value. */
  async #submissionFailure({ error, endpoint, id, outputPath, overwrite }) {
    const state = typeof error?.state === 'string' ? error.state : '';

    // A terminal job carried by the failing response is a real result.
    if (error?.response?.id === id && terminal(error.response.state)) {
      return this.finalize({ job: error.response, endpoint, id, outputPath, overwrite });
    }

    // Cancelled before dispatch, or the journal refused the write: nothing ran.
    if (state === 'not-submitted' || error?.notDispatched) {
      const note = await this.#note({ phase: 'not-submitted', id, state: 'not-submitted', outcome: 'not-submitted', url: endpoint.url, executionMayHaveOccurred: false, error: error?.message ?? '' });
      return {
        ok: false,
        status: 0,
        outcome: 'not-submitted',
        state: 'not-submitted',
        id,
        result: '',
        error: error?.message ?? 'Submission was cancelled before dispatch.',
        logs: [],
        executionMayHaveOccurred: false,
        url: endpoint.url,
        projectPath: typeof endpoint.projectPath === 'string' ? endpoint.projectPath : '',
        hint: joinHints('Nothing was submitted or executed, so retrying the same ID is safe.', note),
      };
    }

    // The Editor refused the submission before accepting it.
    if (state === 'rejected') {
      const note = await this.#note({ phase: 'rejected', id, status: error?.status ?? 0, url: endpoint.url, executionMayHaveOccurred: false, error: error?.message ?? '' });
      return {
        ok: false,
        status: Number.isInteger(error?.status) ? error.status : 0,
        outcome: 'rejected',
        state: 'rejected',
        id,
        result: '',
        error: error?.message ?? String(error),
        logs: [],
        executionMayHaveOccurred: false,
        url: endpoint.url,
        projectPath: typeof endpoint.projectPath === 'string' ? endpoint.projectPath : '',
        hint: joinHints(explainFailure({ status: error?.status, message: error?.message, state }, { action: 'execute' }), note),
      };
    }

    // Wait budget reached while the job is still queued/compiling/running.
    if (error?.exitCode === 2 && !error.aborted && !error.invalidResponse && state && state !== 'unknown') {
      this.invalidate();
      const value = this.#pendingValue({ endpoint, id, state, interrupted: false, executionMayHaveOccurred: error.executionMayHaveOccurred ?? true, error: error?.message });
      value.hint = joinHints(value.hint, await this.#note({ phase: 'pending', id, state, outcome: value.outcome, url: endpoint.url, executionMayHaveOccurred: true }));
      return value;
    }

    // Interrupted while waiting: the accepted command keeps running.
    if (error?.aborted && state && state !== 'unknown') {
      this.invalidate();
      const value = this.#pendingValue({ endpoint, id, state, interrupted: true, executionMayHaveOccurred: error.executionMayHaveOccurred ?? true, error: error?.message });
      value.hint = joinHints(value.hint, await this.#note({ phase: 'interrupted', id, state, outcome: value.outcome, url: endpoint.url, executionMayHaveOccurred: true, error: error?.message ?? '' }));
      return value;
    }

    // Transport loss or an unusable reply: unknown, never "rejected".
    this.invalidate();
    const unknown = this.#pendingValue({
      endpoint,
      id,
      state: 'unknown',
      interrupted: Boolean(error?.aborted),
      executionMayHaveOccurred: error?.executionMayHaveOccurred ?? true,
      error: error?.message,
    });
    unknown.status = 0;
    unknown.hint = error?.aborted
      ? `The tool call was interrupted after job ${id} was accepted; the command was NOT cancelled and may still be running. Query unity_bridge {"action":"status","id":"${id}"} before doing anything else.`
      : `Submission result is unknown (job ${id}): the write may have been accepted and executed. Query unity_bridge {"action":"status","id":"${id}"} before repeating it, and do not resubmit with a new ID.`;
    unknown.hint = joinHints(unknown.hint, await this.#note({ phase: error?.aborted ? 'interrupted' : 'unknown', id, state: 'unknown', outcome: 'unknown', url: endpoint.url, executionMayHaveOccurred: true, error: error?.message ?? '' }));
    return unknown;
  }

  /** Unity Bridge < 0.2.0 has no job API; keep legacy callers working. */
  async #legacyExec({ endpoint, code, id, waitMs, outputPath, overwrite, signal }) {
    const legacyHint = 'This Editor runs a pre-0.2.0 bridge without the job API: a timeout here means the outcome is unknown and cannot be queried by ID. Update the Unity package to protocol 2.';
    try {
      const data = await request(endpoint.url, '/api/execute', {
        method: 'POST',
        body: { code },
        timeoutMs: waitMs,
        token: this.options.token,
        projectPath: endpoint.projectPath,
        signal,
      });
      const logs = Array.isArray(data?.logs) ? data.logs.map(String) : [];
      const spooled = await this.#spoolBinary(
        { id, state: 'succeeded', operation: 'eval', result: typeof data?.result === 'string' ? data.result : '' },
        { id, outputPath, overwrite },
      );
      const value = {
        ok: true,
        status: 200,
        outcome: 'succeeded',
        state: 'succeeded',
        id,
        result: spooled.job.result,
        error: '',
        logs,
        executionMayHaveOccurred: true,
        url: endpoint.url,
        projectPath: typeof endpoint.projectPath === 'string' ? endpoint.projectPath : '',
        hint: legacyHint,
      };
      if (spooled.outputPath) {
        value.outputPath = spooled.outputPath;
        value.byteLength = spooled.job.byteLength ?? 0;
      } else if (Number.isInteger(spooled.job.byteLength)) value.byteLength = spooled.job.byteLength;
      if (spooled.artifactError) {
        value.artifactError = spooled.artifactError;
        value.hint = joinHints(value.hint, `The binary payload was NOT written to disk: ${spooled.artifactError}. This legacy endpoint cannot recover it by ID; inspect the Editor state before retrying any write.`);
      }
      value.hint = joinHints(value.hint, await this.#note({ phase: 'result', id, state: 'succeeded', outcome: 'succeeded', url: endpoint.url, executionMayHaveOccurred: true }));
      return value;
    } catch (error) {
      if (error?.notDispatched) return this.#submissionFailure({ error, endpoint, id, outputPath, overwrite });
      const unknown = error?.transport || error?.aborted;
      if (unknown) this.invalidate();
      const note = await this.#note({ phase: unknown ? 'unknown' : 'failed', id, state: unknown ? 'unknown' : 'failed', outcome: unknown ? 'unknown' : 'failed', url: endpoint.url, executionMayHaveOccurred: true, error: error?.message ?? '' });
      return {
        ok: false,
        status: unknown ? 0 : Number.isInteger(error?.status) ? error.status : 0,
        outcome: unknown ? 'unknown' : 'failed',
        state: unknown ? 'unknown' : 'failed',
        id,
        result: '',
        error: error?.message ?? String(error),
        logs: [],
        executionMayHaveOccurred: true,
        url: endpoint.url,
        projectPath: typeof endpoint.projectPath === 'string' ? endpoint.projectPath : '',
        hint: joinHints(legacyHint, explainFailure({ status: error?.status, message: error?.message, transport: error?.transport, aborted: error?.aborted }, { action: 'execute' }), note),
      };
    }
  }

  /**
   * Save an `@b64:` payload without conflating the artifact with the command.
   *
   * A write failure (existing file, bad base64, oversized payload, permission)
   * leaves the job facts untouched and is reported through `artifactError`; the
   * command is still complete and its result stays queryable by ID.
   */
  async #spoolBinary(job, { id, outputPath, overwrite }) {
    if (typeof job?.result !== 'string' || !job.result.startsWith('@b64:')) return { job };
    const target = outputPath ?? defaultOutputFile(id, job, this.options.outputDir);
    const resolved = path.resolve(target);
    try {
      const saved = await saveBinary(job, target, { overwrite });
      return { job: { ...saved, outputPath: saved.output }, outputPath: saved.output };
    } catch (error) {
      const bytes = binaryLength(job.result);
      const reason = error?.code === 'EEXIST'
        ? `the file already exists at ${resolved}, and its content is not known to be this result (pass a new outputPath, or overwrite: true to replace it)`
        : `${error?.message ?? error}${error?.code ? ` (${error.code})` : ''}`;
      return {
        job: {
          ...job,
          result: Number.isInteger(bytes) ? `[binary ${bytes} bytes, not written to disk]` : '[binary result, not written to disk]',
          ...(Number.isInteger(bytes) ? { byteLength: bytes } : {}),
        },
        artifactError: reason,
      };
    }
  }
}

function joinHints(...parts) {
  return parts.filter(Boolean).join(' ');
}

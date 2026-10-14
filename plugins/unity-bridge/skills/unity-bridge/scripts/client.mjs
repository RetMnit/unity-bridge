import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const terminal = state => ['succeeded', 'failed', 'cancelled', 'interrupted'].includes(state);
export class BridgeError extends Error {
  constructor(message, details = {}) { super(message); Object.assign(this, details); }
}
export function normalizeProject(value) {
  const p = path.resolve(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? p.toLowerCase() : p;
}
export function validateUrl(value) {
  const u = new URL(value);
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(u.hostname) || u.username || u.password || u.pathname !== '/' || u.search || u.hash)
    throw new BridgeError('Bridge URL must be an HTTP localhost origin, e.g. http://127.0.0.1:6417.');
  return u.origin;
}
export async function request(url, route, { method = 'GET', body, timeoutMs = 10000, token = process.env.UNITY_BRIDGE_TOKEN, projectPath } = {}) {
  const headers = { accept: 'application/json' };
  if (projectPath) headers['x-unity-bridge-project'] = Buffer.from(normalizeProject(projectPath), 'utf8').toString('base64');
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  try {
    const res = await fetch(url + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(Math.max(1, Math.round(timeoutMs))), redirect: 'error' });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new BridgeError('Bridge returned invalid JSON.', { status: res.status }); }
    if (!res.ok) throw new BridgeError(data.error || `HTTP ${res.status}`, { status: res.status, response: data });
    return data;
  } catch (e) {
    if (e instanceof BridgeError) throw e;
    throw new BridgeError(e.name === 'TimeoutError' ? 'Bridge request timed out.' : e.message, { transport: true });
  }
}
export function discoveryDirectory() {
  const local = process.env.LOCALAPPDATA || (process.platform === 'darwin' ? path.join(homedir(), 'Library', 'Application Support') : path.join(homedir(), '.local', 'share'));
  return path.join(local, 'UnityBridge', 'editors');
}
export async function discover({ directory = discoveryDirectory() } = {}) {
  let files;
  try { files = await readdir(directory); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  const candidates = await Promise.all(files.filter(f => f.endsWith('.json')).map(async f => {
    try {
      const saved = JSON.parse(await readFile(path.join(directory, f), 'utf8'));
      if (!Number.isInteger(saved.port) || saved.port < 1024 || saved.port > 65535) return null;
      const url = `http://127.0.0.1:${saved.port}`;
      const health = await request(url, '/api/health', { timeoutMs: 1500 });
      return health.instanceId === saved.instanceId && health.pid === saved.pid ? { ...health, url } : null;
    } catch { return null; }
  }));
  return candidates.filter(Boolean);
}
export function selectEditor(editors, { project, cwd = process.cwd() } = {}) {
  const target = project && normalizeProject(project);
  let matches = target ? editors.filter(e => e.projectPath && normalizeProject(e.projectPath) === target) : editors;
  if (!target && matches.length > 1) {
    const current = normalizeProject(cwd);
    const near = matches.filter(e => e.projectPath && (current === normalizeProject(e.projectPath) || current.startsWith(normalizeProject(e.projectPath) + path.sep)));
    if (near.length === 1) matches = near;
  }
  if (matches.length !== 1) throw new BridgeError(matches.length ? 'Multiple Editors match. Specify --project or --url.' : 'No matching Editor. Open the project with Unity Bridge installed.', { editors: editors.map(e => ({ projectPath: e.projectPath, url: e.url })) });
  return matches[0];
}
export async function connect(options = {}) {
  if (options.url || process.env.UNITY_BRIDGE_URL) {
    const url = validateUrl(options.url || process.env.UNITY_BRIDGE_URL);
    const health = await request(url, '/api/health', { timeoutMs: 3000 });
    if (options.project && (!health.projectPath || normalizeProject(health.projectPath) !== normalizeProject(options.project)))
      throw new BridgeError('Connected Editor does not match --project.', { actualProject: health.projectPath });
    return { ...health, url };
  }
  const editors = await discover(options);
  // Discovery is authoritative: do not silently choose a fixed port among multiple Editors.
  if (editors.length || options.project) return selectEditor(editors, options);
  const url = 'http://127.0.0.1:6417';
  return { ...await request(url, '/api/health', { timeoutMs: 3000 }), url };
}
export async function pollJob(url, id, { timeoutMs = 60000, intervalMs = 250, projectPath } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last, lastError;
  do {
    try {
      last = await request(url, `/api/jobs/${encodeURIComponent(id)}`, { timeoutMs: Math.min(5000, Math.max(1, deadline - Date.now())), projectPath });
      if (terminal(last.state)) return last;
    } catch (e) {
      lastError = e;
      if (!e.transport) throw e; // Unknown/evicted ID is never resubmitted.
    }
    await new Promise(r => setTimeout(r, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
  } while (Date.now() < deadline);
  throw new BridgeError('Wait deadline reached. Query this ID again; do not repeat the write with a new ID.',
    { id, state: last?.state || 'unknown', executionMayHaveOccurred: last?.executionMayHaveOccurred ?? true, lastError: lastError?.message, exitCode: 2 });
}
export async function submit(url, body, { id = randomUUID(), timeoutMs = 60000, wait = true, onId, projectPath } = {}) {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new BridgeError('Invalid command ID.');
  onId?.(id);
  let accepted;
  try { accepted = await request(url, '/api/jobs', { method: 'POST', body: { ...body, id }, timeoutMs: Math.min(timeoutMs, 10000), projectPath }); }
  catch (e) {
    if (e.response?.id === id && terminal(e.response.state)) return e.response;
    if (e.transport) throw new BridgeError('Submission result is unknown. Query this ID before doing anything else.', { id, state: 'unknown', executionMayHaveOccurred: true, cause: e.message, exitCode: 2 });
    throw e;
  }
  return wait && !terminal(accepted.state) ? pollJob(url, id, { timeoutMs, projectPath }) : accepted;
}
export async function saveBinary(job, output, { overwrite = false } = {}) {
  if (!job.result?.startsWith('@b64:')) return job;
  const data = Buffer.from(job.result.slice(5), 'base64');
  const copy = { ...job, result: `[binary ${data.length} bytes]`, byteLength: data.length };
  if (output) {
    const file = path.resolve(output);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data, { flag: overwrite ? 'w' : 'wx' });
    copy.output = file;
  } else copy.hint = 'Use --output <path> to save binary results. The full result remains queryable by ID.';
  return copy;
}

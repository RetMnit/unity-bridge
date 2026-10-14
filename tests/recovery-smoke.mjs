// Isolated Editor only: intentionally delays its main thread, then reloads its domain.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connect, request, submit, pollJob } from '../plugins/unity-bridge/skills/unity-bridge/scripts/client.mjs';
const project = process.argv[2];
if (!project) throw new Error('Pass an isolated project root.');
const editor = await connect({ project });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const long = await submit(editor.url, { code: 'System.Threading.Thread.Sleep(2500); return "long-done";' }, { wait: false });
for (let i = 0; i < 100; i++) { if ((await request(editor.url, `/api/jobs/${long.id}`)).state === 'running') break; await sleep(20); }
assert.equal((await request(editor.url, `/api/jobs/${long.id}`)).state, 'running', 'Running status must be readable while main thread is busy.');
const cancelled = await submit(editor.url, { code: 'throw new Exception("must not run");' }, { wait: false });
assert.equal(cancelled.state, 'queued');
assert.equal((await request(editor.url, `/api/jobs/${cancelled.id}`, { method: 'DELETE' })).state, 'cancelled');
const expires = await submit(editor.url, { code: 'throw new Exception("expired command ran");', queueTimeoutMs: 1000 }, { wait: false });
await assert.rejects(pollJob(editor.url, long.id, { timeoutMs: 30, intervalMs: 10 }), e => e.exitCode === 2 && e.id === long.id);
assert.equal((await pollJob(editor.url, long.id)).result, 'long-done');
assert.equal((await pollJob(editor.url, expires.id)).state, 'cancelled');
const stableId = randomUUID();
const code = 'return "durable";';
assert.equal((await submit(editor.url, { code }, { id: stableId })).result, 'durable');
const reload = await submit(editor.url, { code: 'EditorApplication.delayCall += () => EditorUtility.RequestScriptReload(); return "reload-scheduled";' });
assert.equal(reload.state, 'succeeded');
let after;
for (let i = 0; i < 120; i++) {
  try { after = await request(editor.url, '/api/health'); if (after.instanceId !== editor.instanceId) break; } catch { }
  await sleep(250);
}
assert(after && after.instanceId !== editor.instanceId, 'Domain did not reload. In a graphical Editor, keep the Unity window focused so pending script reload can run.');
assert.equal((await request(editor.url, `/api/jobs/${stableId}`)).result, 'durable');
assert.equal((await submit(editor.url, { code }, { id: stableId })).result, 'durable');
console.log(JSON.stringify({ checks: ['status responsive during execution', 'queued cancellation', 'queue deadline', 'client wait deadline with later recovery', 'domain reload restart', 'durable result and dedup after reload'], stableId, instanceChanged: true }, null, 2));

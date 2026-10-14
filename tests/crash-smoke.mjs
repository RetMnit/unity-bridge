// Explicit opt-in only. Kills and restarts an isolated Editor to verify durable running intent.
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { connect, request, submit } from '../plugins/unity-bridge/skills/unity-bridge/scripts/client.mjs';
const [project, executable, optIn] = process.argv.slice(2);
if (!project || !executable || optIn !== '--restart-isolated-editor') throw new Error('Usage: crash-smoke.mjs <isolated-project> <Unity executable> --restart-isolated-editor');
const editor = await connect({ project });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const code = 'System.Threading.Thread.Sleep(10000); return "must-be-interrupted";';
const job = await submit(editor.url, { code }, { wait: false });
let running;
for (let i = 0; i < 100; i++) { running = await request(editor.url, `/api/jobs/${job.id}`); if (running.state === 'running') break; await sleep(30); }
assert.equal(running.state, 'running');
assert(Number.isInteger(editor.pid) && editor.pid > 0);
process.kill(editor.pid);
await sleep(1000);
const child = spawn(executable, ['-batchmode', '-nographics', '-projectPath', path.resolve(project), '-logFile', path.join(path.resolve(project), '..', 'restart.log')], { detached: true, stdio: 'ignore', windowsHide: true });
child.unref();
let restarted;
for (let i = 0; i < 100; i++) {
  try { restarted = await connect({ project }); if (restarted.pid !== editor.pid) break; } catch { }
  await sleep(500);
}
assert(restarted && restarted.pid !== editor.pid, 'Editor failed to restart.');
const restored = await request(restarted.url, `/api/jobs/${job.id}`);
assert.equal(restored.state, 'interrupted'); assert.equal(restored.executionMayHaveOccurred, true);
assert.equal((await submit(restarted.url, { code }, { id: job.id })).state, 'interrupted');
console.log(JSON.stringify({ checks: ['forced exit during execution', 'running intent recovered as interrupted', 'same ID not replayed after process restart'], id: job.id, oldPid: editor.pid, newPid: restarted.pid }, null, 2));

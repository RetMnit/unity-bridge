import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { selectEditor, validateUrl, submit, pollJob, discover, saveBinary, request } from '../plugins/unity-bridge/skills/unity-bridge/scripts/client.mjs';

async function server(t, handler) {
  const s = http.createServer(handler);
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { s.closeAllConnections(); s.close(r); }));
  return `http://127.0.0.1:${s.address().port}`;
}
function json(res, data, status = 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); }

test('selects exact project and refuses ambiguous editors', () => {
  const a = { projectPath: path.resolve('A'), url: 'a' }, b = { projectPath: path.resolve('B'), url: 'b' };
  assert.equal(selectEditor([a, b], { project: a.projectPath }), a);
  assert.equal(selectEditor([a, b], { cwd: path.join(b.projectPath, 'Assets') }), b);
  assert.throws(() => selectEditor([a, b], { cwd: path.resolve('elsewhere') }), /Multiple/);
  assert.throws(() => selectEditor([a], { project: b.projectPath }), /No matching/);
});
test('only explicit localhost origins are accepted', () => {
  assert.equal(validateUrl('http://127.0.0.1:6417'), 'http://127.0.0.1:6417');
  for (const url of ['https://127.0.0.1', 'http://example.com', 'http://localhost/api', 'http://user:pass@localhost', 'http://localhost?secret=x']) assert.throws(() => validateUrl(url));
});
test('submission is performed once, polling retrieves completed result', async t => {
  let posts = 0, gets = 0, sent;
  const url = await server(t, (req, res) => {
    if (req.method === 'POST') {
      posts++; let body = ''; req.on('data', d => body += d); req.on('end', () => { sent = JSON.parse(body); json(res, { id: sent.id, state: 'queued' }, 202); });
    } else json(res, { id: 'stable', state: ++gets > 1 ? 'succeeded' : 'compiling', result: '42' });
  });
  const result = await submit(url, { code: 'return 42;' }, { id: 'stable' });
  assert.equal(result.result, '42'); assert.equal(posts, 1); assert.equal(gets, 2); assert.equal(sent.id, 'stable');
});
test('lost POST response retains ID and never automatically submits again', async t => {
  let posts = 0, printed;
  const url = await server(t, (req) => { posts++; req.socket.destroy(); });
  await assert.rejects(submit(url, { code: 'write();' }, { id: 'recoverable', onId: id => printed = id }), e => e.id === 'recoverable' && e.exitCode === 2 && e.executionMayHaveOccurred);
  assert.equal(posts, 1); assert.equal(printed, 'recoverable');
});
test('a fast terminal compilation failure preserves the job response', async t => {
  const url = await server(t, (_req, res) => json(res, { id: 'compile-error', state: 'failed', error: 'compile error', executionMayHaveOccurred: false }, 500));
  const result = await submit(url, { code: 'broken' }, { id: 'compile-error' });
  assert.equal(result.state, 'failed'); assert.equal(result.executionMayHaveOccurred, false);
});
test('expired wait and evicted job are not treated as permission to replay', async t => {
  const url = await server(t, (_req, res) => json(res, { state: 'running', executionMayHaveOccurred: true }));
  await assert.rejects(pollJob(url, 'slow', { timeoutMs: 40, intervalMs: 5 }), e => e.id === 'slow' && e.exitCode === 2);
  const missing = await server(t, (_req, res) => json(res, { error: 'unknown ID' }, 404));
  await assert.rejects(pollJob(missing, 'evicted'), e => e.status === 404);
});
test('stale discovery PID/instance cannot select a different Editor', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'unity-discovery-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const url = await server(t, (_req, res) => json(res, { pid: 22, instanceId: 'new' }));
  const port = Number(new URL(url).port);
  await writeFile(path.join(directory, 'old.json'), JSON.stringify({ port, pid: 11, instanceId: 'old' }));
  assert.deepEqual(await discover({ directory }), []);
  await writeFile(path.join(directory, 'old.json'), JSON.stringify({ port, pid: 22, instanceId: 'new' }));
  assert.equal((await discover({ directory }))[0].url, url);
});
test('binary saving suppresses payload and refuses accidental overwrite', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'unity-binary-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'result.bin'), job = { result: '@b64:' + Buffer.from('hello').toString('base64') };
  const saved = await saveBinary(job, file); assert.equal(saved.byteLength, 5); assert.equal(await readFile(file, 'utf8'), 'hello');
  assert(!saved.result.includes('aGVsbG8=')); await assert.rejects(saveBinary(job, file), e => e.code === 'EEXIST');
  await saveBinary(job, file, { overwrite: true });
});
test('authentication failures stay explicit', async t => {
  const url = await server(t, (req, res) => json(res, req.headers.authorization ? { ok: true } : { error: 'Authentication required' }, req.headers.authorization ? 200 : 401));
  await assert.rejects(request(url, '/api/health', { token: '' }), e => e.status === 401);
  assert.equal((await request(url, '/api/health', { token: 'test-only' })).ok, true);
});
test('requests carry the selected project identity', async t => {
  let guard;
  const url = await server(t, (req, res) => { guard = req.headers['x-unity-bridge-project']; json(res, { ok: true }); });
  const project = path.resolve('项目');
  await request(url, '/api/health', { projectPath: project });
  assert.equal(Buffer.from(guard, 'base64').toString('utf8'), process.platform === 'win32' ? project.toLowerCase() : project);
});

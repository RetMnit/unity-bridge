import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { selectEditor, validateUrl, submit, pollJob, discover, saveBinary, request, connect } from '../plugins/unity-bridge/skills/unity-bridge/scripts/client.mjs';

async function server(t, handler) {
  const s = http.createServer(handler);
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { s.closeAllConnections(); s.close(r); }));
  return `http://127.0.0.1:${s.address().port}`;
}
function json(res, data, status = 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(data)); }

test('an explicit token reaches health, discovery, submission and polling', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'unity-token-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const seen = [];
  const url = await server(t, (req, res) => {
    seen.push([req.method, req.url, req.headers.authorization]);
    if (req.headers.authorization !== 'Bearer explicit-test-token') return json(res, { error: 'Unauthorized' }, 401);
    if (req.url === '/api/health') return json(res, { pid: 42, instanceId: 'token-domain', protocol: '2', projectPath: path.resolve('TokenProject') });
    return json(res, { id: 'token-job', state: req.method === 'POST' ? 'queued' : 'succeeded', result: 'ok' });
  });
  await writeFile(path.join(dir, '42.json'), JSON.stringify({ pid: 42, instanceId: 'token-domain', port: Number(new URL(url).port) }));
  const options = { token: 'explicit-test-token' };
  assert.equal((await connect({ url, ...options })).pid, 42);
  assert.equal((await discover({ directory: dir, ...options })).length, 1);
  assert.equal((await submit(url, { code: 'return 1;' }, { id: 'token-job', ...options })).state, 'succeeded');
  assert.equal(seen.length, 4);
  assert.ok(seen.every(([, , auth]) => auth === 'Bearer explicit-test-token'));
});

test('discovery reports authentication rejection instead of pretending no Editor exists', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'unity-auth-discovery-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const url = await server(t, (_req, res) => json(res, { error: 'Invalid token' }, 401));
  await writeFile(path.join(dir, 'secure.json'), JSON.stringify({ pid: 42, instanceId: 'secure-domain', port: Number(new URL(url).port) }));
  await assert.rejects(discover({ directory: dir }), e => e.status === 401 && /UNITY_BRIDGE_TOKEN/.test(e.message));
});

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
  const url = await server(t, (_req, res) => json(res, { id: 'slow', state: 'queued', executionMayHaveOccurred: false }));
  await assert.rejects(pollJob(url, 'slow', { timeoutMs: 40, intervalMs: 5 }), e => e.id === 'slow' && e.exitCode === 2 && e.executionMayHaveOccurred === true);
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
test('pre-aborted submission never sends a write', async t => {
  let posts = 0;
  const url = await server(t, (_req, res) => { posts++; json(res, {}); });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(submit(url, { code: 'write();' }, { id: 'pre-aborted', signal: controller.signal }),
    e => e.id === 'pre-aborted' && e.state === 'not-submitted' && e.executionMayHaveOccurred === false);
  assert.equal(posts, 0);
});
test('cancellation after POST dispatch retains an uncertain command ID', async t => {
  let posts = 0; const controller = new AbortController();
  const url = await server(t, req => { posts++; req.resume(); req.on('end', () => controller.abort()); });
  await assert.rejects(submit(url, { code: 'write();' }, { id: 'post-aborted', signal: controller.signal }),
    e => e.id === 'post-aborted' && e.aborted && e.exitCode === 2 && e.executionMayHaveOccurred);
  assert.equal(posts, 1);
});
test('cancelling a poll wakes its sleep without cancelling the server job', async t => {
  let deletes = 0;
  const controller = new AbortController();
  const url = await server(t, (req, res) => { if (req.method === 'DELETE') deletes++; json(res, { id: 'accepted', state: 'queued', executionMayHaveOccurred: false }); });
  const timer = setTimeout(() => controller.abort(), 50); t.after(() => clearTimeout(timer));
  const start = Date.now();
  await assert.rejects(pollJob(url, 'accepted', { signal: controller.signal, intervalMs: 1000 }),
    e => e.id === 'accepted' && e.aborted && e.state === 'queued' && e.exitCode === 2);
  assert(Date.now() - start < 500); assert.equal(deletes, 0);
});
test('invalid POST replies are uncertain rather than proof of rejection', async t => {
  const url = await server(t, (_req, res) => { res.writeHead(200); res.end('not JSON'); });
  await assert.rejects(submit(url, { code: 'write();' }, { id: 'bad-reply' }),
    e => e.id === 'bad-reply' && e.exitCode === 2 && e.executionMayHaveOccurred);
  const wrong = await server(t, (_req, res) => json(res, { id: 'other-job', state: 'succeeded', result: 'wrong result' }));
  await assert.rejects(submit(wrong, { code: 'write();' }, { id: 'expected-job' }), e => e.id === 'expected-job' && e.exitCode === 2);
});
test('server error without job status retains the command ID', async t => {
  const url = await server(t, (_req, res) => json(res, { error: 'Unexpected server fault' }, 500));
  await assert.rejects(submit(url, { code: 'write();' }, { id: 'server-fault' }), e => e.id === 'server-fault' && e.status === 500 && e.exitCode === 2);
});
test('query rejection preserves ID and never proves the write did not run', async t => {
  const url = await server(t, (_req, res) => json(res, { error: 'History evicted' }, 404));
  await assert.rejects(pollJob(url, 'old-job'), e => e.id === 'old-job' && e.status === 404 && e.executionMayHaveOccurred && e.exitCode === 2);
});
test('artifact failures retain completed job identity and invalid base64 is rejected', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'unity-artifact-')); t.after(() => rm(folder, { recursive: true, force: true }));
  const file = path.join(folder, 'exists.bin'); await writeFile(file, 'original');
  await assert.rejects(saveBinary({ id: 'binary-job', state: 'succeeded', executionMayHaveOccurred: true, result: '@b64:AA==' }, file),
    e => e.id === 'binary-job' && e.state === 'succeeded' && e.code === 'EEXIST');
  assert.equal(await readFile(file, 'utf8'), 'original');
  await assert.rejects(saveBinary({ id: 'bad-binary', result: '@b64:not-base64!' }, file), e => e.id === 'bad-binary');
});
test('maximum-size binary results validate without recursive regex overflow', async () => {
  const bytes = 8 * 1024 * 1024;
  const saved = await saveBinary({ id: 'large-binary', state: 'succeeded', result: '@b64:' + Buffer.alloc(bytes).toString('base64') });
  assert.equal(saved.byteLength, bytes);
  assert.equal(saved.result, `[binary ${bytes} bytes]`);
});

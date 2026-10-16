// DSH adapter tests. Unity is not required: every case runs against an isolated
// mock Editor that speaks protocol 2 over localhost.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { apply, createTools } from '../adapters/dsh/unity-bridge.mjs';
import { BridgeError, JobJournal, UnityBridge, clampMs } from '../adapters/dsh/bridge.mjs';
import { normalizeProject } from '../plugins/unity-bridge/skills/unity-bridge/scripts/client.mjs';

const PROJECT = path.resolve('MockProject');
const OTHER_PROJECT = path.resolve('OtherProject');

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function healthBody(overrides = {}) {
  return {
    ok: true,
    unity: '2022.3.62f3',
    bridge: '0.3.0',
    protocol: '2',
    projectPath: PROJECT,
    projectName: 'MockProject',
    pid: 4242,
    instanceId: 'inst-1',
    sampledUtc: new Date().toISOString(),
    state: 'idle',
    ...overrides,
  };
}

/** Start an isolated protocol-2 Editor stand-in. */
async function startEditor(t, handler) {
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      Promise.resolve(handler(req, res, raw)).catch((error) => send(res, 500, { error: String(error?.message ?? error) }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function tempDir(t, prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function bridgeFor(t, url, extra = {}) {
  const dir = await tempDir(t, 'dsh-bridge-');
  return new UnityBridge({ url, journalPath: path.join(dir, 'jobs.jsonl'), outputDir: path.join(dir, 'out'), ...extra });
}

function toolNamed(tools, name) {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `tool ${name} must be registered`);
  return tool;
}

function renderText(tool, value, args = {}) {
  const blocks = tool.output.render(args, value);
  return Array.isArray(blocks) ? blocks.map((block) => block.text ?? '').join('\n') : String(blocks);
}

const ALLOWED_KEYWORDS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'description', 'title', 'default', 'examples']);
const SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

/** The host rejects any schema outside the enforced subset, so assert it here. */
function assertSubset(schema, where = 'schema') {
  for (const [key, value] of Object.entries(schema)) {
    assert.ok(ALLOWED_KEYWORDS.has(key), `${where}.${key} is outside the enforced JSON Schema subset`);
    if (key === 'type') assert.ok(typeof value === 'string' && SCHEMA_TYPES.has(value), `${where}.type must be one single supported type`);
    if (key === 'properties') for (const [name, sub] of Object.entries(value)) assertSubset(sub, `${where}.properties.${name}`);
    if (key === 'items') assertSubset(value, `${where}.items`);
    if (key === 'additionalProperties') assert.equal(typeof value, 'boolean', `${where}.additionalProperties must be boolean`);
    if (key === 'required') assert.ok(Array.isArray(value) && value.every((item) => typeof item === 'string'), `${where}.required must be an array of strings`);
    if (key === 'enum') assert.ok(Array.isArray(value), `${where}.enum must be an array`);
    if (key === 'oneOf') value.forEach((sub, index) => assertSubset(sub, `${where}.oneOf[${index}]`));
  }
}

test('registers exactly unity_execute and unity_bridge with subset-compliant schemas', async (t) => {
  const url = await startEditor(t, (req, res) => send(res, 200, healthBody()));
  const registered = [];
  const bridge = apply({ tools: { register: (tool) => registered.push(tool) } }, { url, journalPath: path.join(await tempDir(t, 'dsh-reg-'), 'jobs.jsonl') });

  assert.equal(typeof bridge.exec, 'function');
  assert.deepEqual(registered.map((tool) => tool.name), ['unity_execute', 'unity_bridge']);
  for (const tool of registered) {
    assert.equal(typeof tool.description, 'string');
    assertSubset(tool.parameters, `${tool.name}.parameters`);
    assertSubset(tool.output.schema, `${tool.name}.output.schema`);
    assert.equal(typeof tool.output.render, 'function');
    assert.equal(tool.parameters.additionalProperties, false);
  }
  const execute = toolNamed(registered, 'unity_execute');
  // Legacy call shape: { code } only, still required.
  assert.deepEqual(execute.parameters.required, ['code']);
  assert.deepEqual(Object.keys(execute.parameters.properties), ['code', 'project', 'url', 'id', 'wait', 'timeoutSeconds', 'queueTimeoutSeconds', 'outputPath', 'overwrite']);
  const manage = toolNamed(registered, 'unity_bridge');
  assert.deepEqual(manage.parameters.properties.action.enum, ['list', 'health', 'status', 'wait', 'cancel', 'recent']);
  // status/wait can save an existing binary result without re-running C#.
  assert.ok(manage.parameters.properties.outputPath, 'unity_bridge must expose outputPath');
  assert.ok(manage.parameters.properties.overwrite, 'unity_bridge must expose overwrite');
  assert.ok(manage.output.schema.properties.artifactError, 'artifact failures must be reported separately from the job');
  assert.ok(execute.output.schema.properties.artifactError);
});

test('unity_execute({code}) submits once, waits, and returns result plus logs', async (t) => {
  const calls = { posts: [], gets: 0 };
  let poll = 0;
  const url = await startEditor(t, (req, res, raw) => {
    if (req.url === '/api/health') return send(res, 200, healthBody());
    if (req.url === '/api/jobs' && req.method === 'POST') {
      calls.posts.push(JSON.parse(raw));
      return send(res, 202, { id: calls.posts[0].id, state: 'queued', operation: 'eval' });
    }
    calls.gets += 1;
    poll += 1;
    const id = calls.posts[0].id;
    return send(res, 200, poll === 1
      ? { id, state: 'compiling', operation: 'eval' }
      : { id, state: 'succeeded', operation: 'eval', result: '42', error: '', logs: ['hello', 'warn'], executionMayHaveOccurred: true });
  });
  const bridge = await bridgeFor(t, url);
  const tools = createTools(bridge);
  const value = await toolNamed(tools, 'unity_execute').execute({ code: 'return 42;' }, {});

  assert.equal(calls.posts.length, 1, 'exactly one submission');
  assert.equal(calls.posts[0].code, 'return 42;');
  assert.equal(calls.posts[0].operation, 'eval');
  assert.equal(calls.posts[0].queueTimeoutMs, 30000);
  assert.equal(value.ok, true);
  assert.equal(value.outcome, 'succeeded');
  assert.equal(value.result, '42');
  assert.deepEqual(value.logs, ['hello', 'warn']);
  assert.match(value.id, /^[A-Za-z0-9_-]{1,80}$/);
  assert.equal(value.projectPath, PROJECT);

  const rendered = toolNamed(tools, 'unity_execute').output.render({ code: 'return 42;' }, value);
  assert.equal(rendered[0].type, 'text');
  assert.match(rendered[0].text, /unity_execute: succeeded/);
  assert.match(rendered[0].text, /42/);
  assert.match(rendered[0].text, /hello/);
});

test('the job ID is journaled before the request reaches the Editor', async (t) => {
  const dir = await tempDir(t, 'dsh-journal-');
  const journalFile = path.join(dir, 'jobs.jsonl');
  let seenDuringPost = '';
  const url = await startEditor(t, async (req, res, raw) => {
    if (req.url === '/api/health') return send(res, 200, healthBody());
    if (req.method === 'POST') {
      const body = JSON.parse(raw);
      seenDuringPost = await readFile(journalFile, 'utf8').catch(() => '');
      return send(res, 202, { id: body.id, state: 'succeeded', operation: 'eval', result: 'ok', logs: [], executionMayHaveOccurred: true });
    }
    return send(res, 200, { id: 'x', state: 'succeeded' });
  });
  const bridge = new UnityBridge({ url, journalPath: journalFile });
  const value = await createTools(bridge)[0].execute({ code: 'return 1;' }, {});

  assert.match(seenDuringPost, /"phase":"submit"/, 'the journal entry must exist before the POST is handled');
  assert.ok(seenDuringPost.includes(value.id), 'the journal must contain the job ID that was submitted');
  const entries = await new JobJournal(journalFile).recent(10);
  assert.deepEqual(entries.map((entry) => entry.phase), ['submit', 'result']);
  assert.equal(entries[0].executionMayHaveOccurred, true);
  assert.equal(entries[1].state, 'succeeded');
});

test('a wait timeout keeps the ID as pending and never resubmits', async (t) => {
  let posts = 0;
  let jobId = '';
  const url = await startEditor(t, (req, res, raw) => {
    if (req.url === '/api/health') return send(res, 200, healthBody());
    if (req.method === 'POST') { posts += 1; jobId = JSON.parse(raw).id; return send(res, 202, { id: jobId, state: 'queued', operation: 'eval' }); }
    return send(res, 200, { id: jobId, state: 'running', operation: 'eval', executionMayHaveOccurred: true });
  });
  const bridge = await bridgeFor(t, url);
  const tools = createTools(bridge);
  const value = await toolNamed(tools, 'unity_execute').execute({ code: 'LongWork();', timeoutSeconds: 1 }, {});

  assert.equal(posts, 1, 'a timeout must not resubmit');
  assert.equal(value.ok, true, 'a timeout is not a tool failure');
  assert.equal(value.outcome, 'pending');
  assert.equal(value.state, 'running');
  assert.equal(value.executionMayHaveOccurred, true);
  assert.match(value.hint, /status/);
  assert.match(value.hint, /resubmit/i);
  const text = toolNamed(tools, 'unity_execute').output.render({}, value)[0].text;
  assert.match(text, /pending/);
  assert.match(text, new RegExp(value.id));
  const entries = await bridge.recent(10);
  assert.equal(entries.at(-1).id, value.id);
  assert.ok(['pending', 'unknown'].includes(entries.at(-1).outcome));
});

test('a lost submission response is reported as unknown with the preserved ID', async (t) => {
  let posts = 0;
  const url = await startEditor(t, (req, res) => {
    if (req.url === '/api/health') return send(res, 200, healthBody());
    posts += 1;
    req.socket.destroy();
  });
  const bridge = await bridgeFor(t, url);
  const value = await toolNamed(createTools(bridge), 'unity_execute').execute({ code: 'Write();' }, {});

  assert.equal(posts, 1);
  assert.equal(value.ok, true);
  assert.equal(value.outcome, 'unknown');
  assert.equal(value.status, 0);
  assert.match(value.id, /^[A-Za-z0-9_-]{1,80}$/);
  assert.match(value.hint, new RegExp(value.id));
  assert.equal(value.executionMayHaveOccurred, true);
  const entries = await bridge.recent(10);
  assert.equal(entries.at(-1).phase, 'unknown');
  assert.equal(entries.at(-1).id, value.id);
});

test('an interrupted tool call keeps the ID, reports unknown, and does not resubmit', async (t) => {
  let posts = 0;
  const url = await startEditor(t, (req, res, raw) => {
    if (req.url === '/api/health') return send(res, 200, healthBody());
    if (req.method === 'POST') { posts += 1; const body = JSON.parse(raw); return send(res, 202, { id: body.id, state: 'queued', operation: 'eval' }); }
    return new Promise(() => {}); // a job query that never answers: only the caller's signal ends the wait
  });
  const bridge = await bridgeFor(t, url);
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const value = await toolNamed(createTools(bridge), 'unity_execute').execute({ code: 'LongWork();', timeoutSeconds: 30 }, { signal: controller.signal });

  assert.equal(posts, 1, 'an interruption must not resubmit');
  assert.equal(value.state, 'unknown');
  assert.match(value.hint, /interrupted/i);
  assert.match(value.hint, new RegExp(value.id));
  assert.equal(value.executionMayHaveOccurred, true);
  const entries = await bridge.recent(5);
  assert.equal(entries.at(-1).phase, 'interrupted');
  assert.equal(entries.at(-1).id, value.id);
});

test('a call cancelled before dispatch is not-submitted and safe to retry', async (t) => {
  let posts = 0;
  const url = await startEditor(t, (req, res) => {
    if (req.url === '/api/health') return send(res, 200, healthBody());
    posts += 1;
    return send(res, 202, { id: 'unused', state: 'queued' });
  });
  const bridge = await bridgeFor(t, url);
  const controller = new AbortController();
  controller.abort();
  const value = await toolNamed(createTools(bridge), 'unity_execute').execute({ code: 'Write();' }, { signal: controller.signal });

  assert.equal(posts, 0, 'nothing may reach the Editor after cancellation');
  assert.equal(value.ok, false);
  assert.equal(value.outcome, 'not-submitted');
  assert.equal(value.executionMayHaveOccurred, false);
  assert.match(value.hint, /retrying is safe/i);
});

test('unity_bridge reports failure states, waits, and cancels only queued jobs', async (t) => {
  const seen = { deletes: [] };
  const url = await startEditor(t, (req, res) => {
    if (req.url === '/api/health') return send(res, 200, healthBody());
    if (req.method === 'DELETE') {
      seen.deletes.push(req.url);
      if (req.url.endsWith('/queued-1')) return send(res, 200, { id: 'queued-1', state: 'cancelled', executionMayHaveOccurred: false });
      return send(res, 409, { error: 'Job is already running.' });
    }
    if (req.url.endsWith('/failed-1')) {
      return send(res, 200, { id: 'failed-1', state: 'failed', error: 'CS0103: name does not exist', logs: ['err'], executionMayHaveOccurred: false });
    }
    if (req.url.endsWith('/ok-1')) {
      return send(res, 200, { id: 'ok-1', state: 'succeeded', result: 'done', error: '', logs: [], executionMayHaveOccurred: true });
    }
    return send(res, 200, { id: 'running-1', state: 'running', executionMayHaveOccurred: true });
  });
  const bridge = await bridgeFor(t, url);
  const tool = toolNamed(createTools(bridge), 'unity_bridge');

  const failed = await tool.execute({ action: 'status', id: 'failed-1' }, {});
  assert.equal(failed.ok, false, 'a terminal failure is not a success');
  assert.equal(failed.outcome, 'failed');
  assert.equal(failed.executionMayHaveOccurred, false);
  assert.match(failed.error, /CS0103/);
  assert.match(tool.output.render({ action: 'status' }, failed)[0].text, /failed/);
  assert.match(tool.output.render({ action: 'status' }, failed)[0].text, /executionMayHaveOccurred=false/);

  const ok = await tool.execute({ action: 'wait', id: 'ok-1', timeoutSeconds: 2 }, {});
  assert.equal(ok.outcome, 'succeeded');
  assert.equal(ok.result, 'done');

  const cancelled = await tool.execute({ action: 'cancel', id: 'queued-1' }, {});
  assert.equal(cancelled.outcome, 'cancelled');
  const cancellationText = tool.output.render({ action: 'cancel' }, cancelled)[0].text;
  assert.match(cancellationText, /executionMayHaveOccurred=false/);
  assert.doesNotMatch(cancellationText, /Terminal failure/);

  const rejected409 = await tool.execute({ action: 'cancel', id: 'running-1' }, {});
  assert.equal(rejected409.ok, false);
  assert.equal(rejected409.status, 409);
  assert.equal(rejected409.id, 'running-1', 'a failed cancel keeps the job ID');
  assert.notEqual(rejected409.outcome, 'rejected', 'a failed cancel is not a rejected submission');
  assert.equal(rejected409.outcome, 'unknown');
  assert.equal(rejected409.executionMayHaveOccurred, true);
  assert.match(rejected409.hint, /queued/);
  assert.deepEqual(seen.deletes, ['/api/jobs/queued-1', '/api/jobs/running-1']);

  const badId = await tool.execute({ action: 'status', id: '../etc' }, {});
  assert.equal(badId.ok, false);
  assert.match(badId.error, /valid job ID/);
});

test('list and health expose Editor identity, and a wrong project is refused', async (t) => {
  const url = await startEditor(t, (req, res) => {
    if (req.url === '/api/health') return send(res, 200, healthBody());
    return send(res, 200, { id: 'x', state: 'succeeded' });
  });
  const dir = await tempDir(t, 'dsh-discovery-');
  const port = Number(new URL(url).port);
  await writeFile(path.join(dir, 'editor.json'), JSON.stringify({ port, pid: 4242, instanceId: 'inst-1', projectPath: PROJECT }), 'utf8');

  const bridge = new UnityBridge({ directory: dir, journalPath: path.join(dir, 'jobs.jsonl') });
  const tool = toolNamed(createTools(bridge), 'unity_bridge');

  const listed = await tool.execute({ action: 'list' }, {});
  assert.equal(listed.editors.length, 1);
  assert.match(listed.editors[0], new RegExp(port));
  assert.match(tool.output.render({ action: 'list' }, listed)[0].text, /1 Editor/);

  const health = await tool.execute({ action: 'health', project: PROJECT }, {});
  assert.equal(health.protocol, '2');
  assert.equal(health.version, '2022.3.62f3');
  assert.equal(health.projectPath, PROJECT);
  assert.match(tool.output.render({ action: 'health' }, health)[0].text, /protocol 2/);

  const wrong = await tool.execute({ action: 'health', project: OTHER_PROJECT }, {});
  assert.equal(wrong.ok, false);
  assert.match(wrong.error, /No matching Editor|does not match/);
  assert.match(wrong.hint, /project|url/i);

  await assert.rejects(bridge.resolve({ project: OTHER_PROJECT, url }), (error) => error instanceof BridgeError);
});

test('requests carry the selected project identity and refuse an Editor serving another project', async (t) => {
  let guard;
  const url = await startEditor(t, (req, res) => {
    guard = req.headers['x-unity-bridge-project'];
    if (req.url === '/api/health') return send(res, 200, healthBody());
    return send(res, 200, { id: 'job-1', state: 'succeeded', result: 'ok', logs: [], executionMayHaveOccurred: true });
  });
  const bridge = await bridgeFor(t, url, { project: PROJECT });
  const value = await toolNamed(createTools(bridge), 'unity_bridge').execute({ action: 'status', id: 'job-1' }, {});

  assert.equal(value.outcome, 'succeeded');
  assert.equal(Buffer.from(guard, 'base64').toString('utf8'), normalizeProject(PROJECT));

  const mismatch = await toolNamed(createTools(bridge), 'unity_bridge').execute({ action: 'health', project: OTHER_PROJECT, url }, {});
  assert.equal(mismatch.ok, false);
  assert.match(mismatch.error, /does not match/);
});

test('binary results are written to disk, and artifact failures never masquerade as saved output', async (t) => {
  const payload = Buffer.from('PNG-BYTES');
  let posts = 0;
  let mode = 'ok';
  const created = [];
  const url = await startEditor(t, (req, res, raw) => {
    if (req.url === '/api/health') return send(res, 200, healthBody());
    const result = mode === 'broken' ? '@b64:!!!!' : `@b64:${payload.toString('base64')}`;
    if (req.method === 'POST') {
      posts += 1;
      const body = JSON.parse(raw);
      created.push(body.id);
      return send(res, 202, { id: body.id, state: 'succeeded', operation: 'eval', result, error: '', logs: [], executionMayHaveOccurred: true });
    }
    const id = decodeURIComponent(req.url.split('/').pop());
    return send(res, 200, { id, state: 'succeeded', operation: 'screenshot', result, logs: [] });
  });
  const dir = await tempDir(t, 'dsh-binary-');
  const bridge = new UnityBridge({ url, outputDir: path.join(dir, 'out'), journalPath: path.join(dir, 'jobs.jsonl') });
  const tools = createTools(bridge);
  const execute = toolNamed(tools, 'unity_execute');
  const manage = toolNamed(tools, 'unity_bridge');

  const value = await execute.execute({ code: 'return tex.EncodeToPNG();' }, {});
  assert.equal(posts, 1);
  assert.equal(value.outcome, 'succeeded');
  assert.equal(value.byteLength, payload.length);
  assert.equal(value.result, `[binary ${payload.length} bytes]`);
  assert.ok(!JSON.stringify(value).includes(payload.toString('base64')), 'base64 must not reach the model');
  assert.equal(await readFile(value.outputPath, 'utf8'), 'PNG-BYTES');
  assert.equal(value.artifactError, undefined);
  assert.match(value.outputPath, /\.bin$/);

  // An existing, unrelated file must never be reported as this result.
  const occupied = path.join(dir, 'occupied.bin');
  await writeFile(occupied, 'unrelated content', 'utf8');
  const blocked = await execute.execute({ code: 'return tex.EncodeToPNG();', outputPath: occupied }, {});
  assert.equal(blocked.outcome, 'succeeded', 'the command fact survives an artifact failure');
  assert.equal(blocked.state, 'succeeded');
  assert.equal(blocked.byteLength, payload.length, 'the payload size is still reported');
  assert.equal(blocked.outputPath, undefined, 'a failed write is not a saved artifact');
  assert.match(blocked.artifactError, /already exists/);
  assert.match(blocked.artifactError, /not known to be this result/);
  assert.doesNotMatch(blocked.result, /already saved/i);
  assert.match(blocked.result, /not written to disk/);
  assert.match(blocked.hint, /re-save|overwrite|new path/i);
  assert.equal(await readFile(occupied, 'utf8'), 'unrelated content', 'the existing file is untouched');
  assert.match(renderText(execute, blocked), /NOT written/);

  // Saving a stored result by ID must read the job again, never re-run the C#.
  const postsBeforeSave = posts;
  const laterPath = path.join(dir, 'later.png');
  const saved = await manage.execute({ action: 'status', id: created[0], outputPath: laterPath }, {});
  assert.equal(posts, postsBeforeSave, 'saving a stored result never re-runs the snippet');
  assert.equal(saved.outcome, 'succeeded');
  assert.equal(saved.outputPath, laterPath);
  assert.equal(await readFile(laterPath, 'utf8'), 'PNG-BYTES');
  assert.equal(saved.artifactError, undefined);

  // An undecodable payload keeps the command facts and reports the artifact.
  mode = 'broken';
  const broken = await execute.execute({ code: 'return weird();', outputPath: path.join(dir, 'broken.bin') }, {});
  assert.equal(broken.outcome, 'succeeded');
  assert.equal(broken.status, 200);
  assert.ok(broken.artifactError, 'an undecodable payload is an artifact error');
  assert.match(broken.result, /not written to disk/);
  assert.equal(broken.outputPath, undefined);

  // A screenshot default path still applies when a binary needs saving.
  mode = 'ok';
  const bridged = await manage.execute({ action: 'status', id: created[0] }, {});
  assert.match(bridged.result, /binary/);
  assert.ok(bridged.outputPath.endsWith('.png'), 'a screenshot job defaults to a .png path');
});

test('authentication failures are explicit, and both env and configured tokens work', async (t) => {
  const url = await startEditor(t, (req, res) => {
    if (!req.headers.authorization) return send(res, 401, { error: 'Authentication required' });
    return send(res, 200, healthBody());
  });
  const bridge = await bridgeFor(t, url);
  const denied = await toolNamed(createTools(bridge), 'unity_bridge').execute({ action: 'health' }, {});
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 401);
  assert.match(denied.hint, /UNITY_BRIDGE_TOKEN/);
  assert.doesNotMatch(denied.hint, /disable/i, 'never suggest turning authentication off');

  // A token configured on the adapter reaches discovery, health, submit and polling.
  const configured = await bridgeFor(t, url, { token: 'configured-token' });
  const allowed = await toolNamed(createTools(configured), 'unity_bridge').execute({ action: 'health' }, {});
  assert.equal(allowed.ok, true);
  assert.equal(allowed.protocol, '2');

  process.env.UNITY_BRIDGE_TOKEN = 'test-only-token';
  t.after(() => { delete process.env.UNITY_BRIDGE_TOKEN; });
  const viaEnv = await toolNamed(createTools(bridge), 'unity_bridge').execute({ action: 'health' }, {});
  assert.equal(viaEnv.ok, true);
  assert.equal(viaEnv.protocol, '2');
});

test('pre-0.2.0 Editors keep working through the legacy endpoint with an explicit warning', async (t) => {
  let mode = 'ok';
  const url = await startEditor(t, (req, res) => {
    if (req.url === '/api/health') return send(res, 200, { ok: true, unity: '2022.3.62f3', bridge: '0.1.2', projectPath: PROJECT });
    if (mode === 'ok') return send(res, 200, { result: 'legacy-ok', logs: ['old'] });
    req.socket.destroy();
  });
  const bridge = await bridgeFor(t, url);
  const tool = toolNamed(createTools(bridge), 'unity_execute');

  const value = await tool.execute({ code: 'return 1;' }, {});
  assert.equal(value.outcome, 'succeeded');
  assert.equal(value.result, 'legacy-ok');
  assert.deepEqual(value.logs, ['old']);
  assert.match(value.hint, /pre-0\.2\.0/);

  const controller = new AbortController();
  controller.abort();
  const stopped = await tool.execute({ code: 'Write();' }, { signal: controller.signal });
  assert.equal(stopped.outcome, 'not-submitted');
  assert.equal(stopped.executionMayHaveOccurred, false);

  mode = 'drop';
  const unknown = await tool.execute({ code: 'Write();' }, {});
  assert.equal(unknown.outcome, 'unknown');
  assert.equal(unknown.ok, false);
  assert.match(unknown.hint, /pre-0\.2\.0/);
  assert.match(unknown.id, /^[A-Za-z0-9_-]{1,80}$/);
});

test('argument validation and rendering stay bounded', async (t) => {
  const url = await startEditor(t, (req, res) => send(res, 200, healthBody()));
  const bridge = await bridgeFor(t, url);
  const tools = createTools(bridge);
  const execute = toolNamed(tools, 'unity_execute');

  const empty = await execute.execute({ code: '   ' }, {});
  assert.equal(empty.ok, false);
  assert.equal(empty.outcome, 'rejected');
  assert.match(empty.error, /non-empty/);

  const badAction = await toolNamed(tools, 'unity_bridge').execute({ action: 'explode' }, {});
  assert.equal(badAction.ok, false);
  assert.match(badAction.error, /action must be one of/);

  assert.throws(() => clampMs(0, { fallback: 1000 }), /positive number/);
  assert.equal(clampMs(999999, { fallback: 1000 }), 300000);

  const long = { ...empty, outcome: 'succeeded', ok: true, result: Array.from({ length: 900 }, (_, i) => `line ${i}`).join('\n') };
  const text = execute.output.render({}, long)[0].text;
  assert.ok(text.length <= 12_100, `rendered text must stay bounded (was ${text.length})`);
  assert.match(text, /truncated/);
});

test('a registration rejection degrades to a placeholder instead of failing the plugin', async (t) => {
  const url = await startEditor(t, (req, res) => send(res, 200, healthBody()));
  const dir = await tempDir(t, 'dsh-fallback-');

  // Only the sibling tool is rejected: the working tool stays registered.
  const partial = [];
  apply({
    tools: { register: (tool) => { if (tool.name === 'unity_bridge') throw new Error('unsupported JSON schema: probe'); partial.push(tool); } },
  }, { url, journalPath: path.join(dir, 'a.jsonl') });
  assert.deepEqual(partial.map((tool) => tool.name), ['unity_execute']);
  const survivor = await partial[0].execute({ code: 'return 1;' }, {});
  assert.equal(survivor.ok, true);

  // unity_execute itself rejected: a self-explaining placeholder is registered, nothing throws.
  const collected = [];
  apply({
    tools: { register: (tool) => { collected.push(tool); if (tool.name === 'unity_execute') throw new Error('unsupported JSON schema: everything'); } },
  }, { url });
  assert.deepEqual(collected.map((tool) => tool.name), ['unity_execute', 'unity_bridge', 'unity_execute']);
  const placeholder = collected[2];
  assert.match(placeholder.description, /Unavailable/);
  const denied = await placeholder.execute({ code: 'return 1;' }, {});
  assert.equal(denied.ok, false);
  assert.match(denied.error, /could not be registered/);
});

test('recent recovers IDs from the local journal after an interrupted turn', async (t) => {
  const dir = await tempDir(t, 'dsh-recent-');
  const journal = new JobJournal(path.join(dir, 'jobs.jsonl'));
  await journal.record({ phase: 'interrupted', id: 'recover-me', state: 'unknown', url: 'http://127.0.0.1:6417', projectPath: PROJECT, executionMayHaveOccurred: true });
  const bridge = new UnityBridge({ url: 'http://127.0.0.1:1', journalPath: journal.file });
  const listed = await toolNamed(createTools(bridge), 'unity_bridge').execute({ action: 'recent', limit: 5 }, {});

  assert.equal(listed.entries.length, 1);
  assert.match(listed.entries[0], /recover-me/);
  assert.equal(listed.journalPath, journal.file);
  assert.match(toolNamed(createTools(bridge), 'unity_bridge').output.render({ action: 'recent' }, listed)[0].text, /recover-me/);
});

test('an unwritable journal blocks the write instead of losing the ID', async (t) => {
  let posts = 0;
  const url = await startEditor(t, (req, res, raw) => {
    if (req.url === '/api/health') return send(res, 200, healthBody());
    posts += 1;
    return send(res, 202, { id: JSON.parse(raw).id, state: 'succeeded', result: 'ok', logs: [] });
  });
  const dir = await tempDir(t, 'dsh-journal-blocked-');
  const blocker = path.join(dir, 'blocker');
  await writeFile(blocker, 'not a directory', 'utf8');
  const bridge = new UnityBridge({ url, journalPath: path.join(blocker, 'jobs.jsonl') });
  const value = await toolNamed(createTools(bridge), 'unity_execute').execute({ code: 'Write();' }, {});

  assert.equal(posts, 0, 'no write may reach the Editor when the ID cannot be journaled');
  assert.equal(value.outcome, 'not-submitted');
  assert.equal(value.state, 'not-submitted');
  assert.match(value.id, /^[A-Za-z0-9_-]{1,80}$/);
  assert.equal(value.executionMayHaveOccurred, false);
  assert.match(value.error, /journal is not writable/i);
  assert.match(value.hint, /safe/i);
});

test('a journal failure after execution never rewrites the command outcome', async (t) => {
  const url = await startEditor(t, (req, res, raw) => {
    if (req.url === '/api/health') return send(res, 200, healthBody());
    if (req.method === 'POST') {
      const body = JSON.parse(raw);
      return send(res, 202, { id: body.id, state: 'succeeded', operation: 'eval', result: 'done', error: '', logs: [], executionMayHaveOccurred: true });
    }
    return send(res, 200, { id: 'x', state: 'succeeded' });
  });
  const dir = await tempDir(t, 'dsh-journal-flaky-');
  class FlakyJournal extends JobJournal {
    constructor(file) { super(file); this.writes = 0; }
    async record(entry) {
      this.writes += 1;
      if (this.writes > 1) throw new Error('disk full');
      return super.record(entry);
    }
  }
  const journal = new FlakyJournal(path.join(dir, 'jobs.jsonl'));
  const value = await toolNamed(createTools(new UnityBridge({ url, journal })), 'unity_execute').execute({ code: 'return 1;' }, {});

  assert.equal(value.outcome, 'succeeded');
  assert.equal(value.result, 'done');
  assert.match(value.hint, /journal could not be updated/i);
  assert.match(value.hint, /unaffected/i);
  assert.equal((await journal.recent(5)).length, 1, 'only the durable pre-submission entry exists');
});

test('failed job queries keep the ID and endpoint and never claim the write did not run', async (t) => {
  let mode = 'mismatch';
  const url = await startEditor(t, (req, res) => {
    if (req.url === '/api/health') return send(res, 200, healthBody());
    if (mode === 'mismatch') return send(res, 200, { id: 'someone-else', state: 'succeeded', result: 'x' });
    if (mode === 'missing') return send(res, 404, { error: 'unknown ID' });
    req.socket.destroy();
  });
  const bridge = await bridgeFor(t, url, { project: PROJECT });
  const manage = toolNamed(createTools(bridge), 'unity_bridge');

  const mismatched = await manage.execute({ action: 'status', id: 'job-abc' }, {});
  assert.equal(mismatched.ok, false);
  assert.equal(mismatched.id, 'job-abc');
  assert.equal(mismatched.outcome, 'unknown');
  assert.equal(mismatched.executionMayHaveOccurred, true);
  assert.equal(mismatched.url, url, 'the endpoint survives a failed query');
  assert.equal(mismatched.projectPath, PROJECT);
  assert.match(mismatched.hint, /does not prove/i);
  assert.doesNotMatch(mismatched.hint, /nothing was submitted|was not submitted/i);

  mode = 'missing';
  const missing = await manage.execute({ action: 'status', id: 'job-abc' }, {});
  assert.equal(missing.id, 'job-abc');
  assert.equal(missing.status, 404);
  assert.equal(missing.outcome, 'unknown');
  assert.match(missing.hint, /evicted|unknown/i);
  assert.match(missing.hint, /does not prove/i);
  assert.equal((missing.hint.match(/does not prove/gi) || []).length, 1);

  mode = 'drop';
  const dropped = await manage.execute({ action: 'wait', id: 'job-abc', timeoutSeconds: 1 }, {});
  assert.equal(dropped.id, 'job-abc');
  assert.equal(dropped.outcome, 'unknown');
  assert.equal(dropped.url, url);
  assert.equal(dropped.projectPath, PROJECT);
  assert.doesNotMatch(dropped.hint, /nothing was submitted|was not submitted|not executed/i);

  const cancelled = await manage.execute({ action: 'cancel', id: 'job-abc' }, {});
  assert.equal(cancelled.id, 'job-abc');
  assert.equal(cancelled.outcome, 'unknown');
  assert.notEqual(cancelled.outcome, 'rejected');
  assert.equal(cancelled.url, url);
});

test('wait never queries past its budget or in the background', async (t) => {
  let gets = 0;
  const url = await startEditor(t, (req, res, raw) => {
    if (req.url === '/api/health') return send(res, 200, healthBody());
    if (req.method === 'POST') {
      const body = JSON.parse(raw);
      return send(res, 202, { id: body.id, state: 'queued', operation: 'eval' });
    }
    gets += 1;
    const id = decodeURIComponent(req.url.split('/').pop());
    return send(res, 200, { id, state: 'running', operation: 'eval', executionMayHaveOccurred: true });
  });
  const bridge = await bridgeFor(t, url);
  const started = Date.now();
  const value = await toolNamed(createTools(bridge), 'unity_bridge').execute({ action: 'wait', id: 'job-wait', timeoutSeconds: 1 }, {});
  const elapsed = Date.now() - started;

  assert.equal(value.outcome, 'pending');
  assert.equal(value.id, 'job-wait');
  assert.ok(elapsed < 2000, `wait must stay within its budget (took ${elapsed}ms)`);
  const seen = gets;
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.equal(gets, seen, 'no query may run after the wait returned');
});

test('an accepted job whose polling fails is never reported as a rejected submission', async (t) => {
  let jobId = '';
  const url = await startEditor(t, (req, res, raw) => {
    if (req.url === '/api/health') return send(res, 200, healthBody());
    if (req.method === 'POST') {
      jobId = JSON.parse(raw).id;
      return send(res, 202, { id: jobId, state: 'running', operation: 'eval' });
    }
    return send(res, 404, { error: 'unknown ID' });
  });
  const bridge = await bridgeFor(t, url);
  const value = await toolNamed(createTools(bridge), 'unity_execute').execute({ code: 'Write();' }, {});

  assert.equal(value.id, jobId);
  assert.notEqual(value.outcome, 'rejected');
  assert.ok(['unknown', 'pending'].includes(value.outcome));
  assert.equal(value.executionMayHaveOccurred, true);
  assert.match(value.hint, /status/i);
});

test('a query that fails before reaching the job layer still keeps the requested ID', async (t) => {
  // Nothing is listening on this port: resolution fails before any job request.
  const dead = 'http://127.0.0.1:9';
  const bridge = new UnityBridge({ url: dead, project: PROJECT, journalPath: path.join(await tempDir(t, 'dsh-dead-'), 'jobs.jsonl') });
  const manage = toolNamed(createTools(bridge), 'unity_bridge');

  for (const action of ['status', 'wait', 'cancel']) {
    const value = await manage.execute({ action, id: 'job-dead', url: dead, project: PROJECT }, {});
    assert.equal(value.ok, false, `${action} must fail`);
    assert.equal(value.id, 'job-dead', `${action} must keep the requested ID`);
    assert.equal(value.url, dead, `${action} must keep the endpoint`);
    assert.equal(value.projectPath, PROJECT, `${action} must keep the project`);
    assert.equal(value.outcome, 'unknown', `${action} must not claim a rejected submission`);
    assert.equal(value.executionMayHaveOccurred, true, `${action} cannot prove the write did not run`);
    assert.match(value.hint, /does not prove/i);
  }

  // An invalid ID stays a rejection, not an unknown outcome.
  const invalid = await manage.execute({ action: 'status', id: 'bad id' }, {});
  assert.equal(invalid.outcome, 'rejected');
  assert.equal(invalid.id, 'bad id');
  assert.equal(invalid.executionMayHaveOccurred, false);
});

test('failure guidance distinguishes origin rejection, project mismatch, ID conflict and cancel state', async (t) => {
  let mode = 'origin';
  const url = await startEditor(t, (req, res) => {
    if (req.url === '/api/health') return send(res, 200, healthBody());
    if (mode === 'origin') return send(res, 403, { error: 'Origin header not allowed' });
    if (mode === 'project') return send(res, 409, { error: 'Project mismatch: request guard does not match this Editor' });
    if (mode === 'conflict') return send(res, 409, { error: 'Job ID already exists with different content' });
    return send(res, 404, { error: 'no route' });
  });
  const bridge = await bridgeFor(t, url);
  const execute = toolNamed(createTools(bridge), 'unity_execute');
  const manage = toolNamed(createTools(bridge), 'unity_bridge');

  const origin = await execute.execute({ code: 'return 1;' }, {});
  assert.equal(origin.status, 403);
  assert.match(origin.hint, /origin|browser/i);
  assert.doesNotMatch(origin.hint, /disable/i);

  mode = 'project';
  const project = await execute.execute({ code: 'return 1;' }, {});
  assert.equal(project.outcome, 'rejected');
  assert.match(project.hint, /project mismatch/i);

  mode = 'conflict';
  const conflict = await execute.execute({ code: 'return 1;' }, {});
  assert.match(conflict.hint, /id conflict/i);

  mode = 'noroute';
  const old = await manage.execute({ action: 'status', id: 'job-x' }, {});
  assert.equal(old.status, 404);
  assert.equal(old.id, 'job-x');
  assert.match(old.hint, /evicted|unknown/i);
});

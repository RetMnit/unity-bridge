// Run only against an isolated Editor project. No scene/asset changes are saved.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connect, request, submit } from '../plugins/unity-bridge/skills/unity-bridge/scripts/client.mjs';
const project = process.argv[2];
if (!project) throw new Error('Usage: node tests/editor-smoke.mjs <isolated-project-root>');
const editor = await connect({ project });
assert.equal(editor.protocol, '2');
const checks = [];
async function run(label, code, expected) {
  const result = await submit(editor.url, { code });
  assert.equal(result.state, 'succeeded', JSON.stringify(result));
  if (expected !== undefined) assert.equal(result.result, expected);
  checks.push(label); return result;
}
await run('legacy endpoint contract', 'Debug.Log("legacy-ok"); return 42;', '42');
const legacy = await request(editor.url, '/api/execute', { method: 'POST', body: { code: 'return "legacy-response";' }, timeoutMs: 35000 });
assert.equal(legacy.result, 'legacy-response'); assert(Array.isArray(legacy.logs)); checks.push('legacy POST /api/execute');
await run('C# 9 / local function / List / Array / Convert / Enum / IO / AppDomain',
  'int Local(int n) => n switch { 1 => 7, _ => 0 }; List<int> xs = new() { Local(1) }; var a = new[] { 1, 2 }; System.Array.Reverse(a); return xs[0] + ":" + Convert.ToBase64String(new byte[]{1,2}) + ":" + System.IO.Path.GetFileName("x/y.txt") + ":" + Enum.GetName(typeof(DayOfWeek), DayOfWeek.Monday) + ":" + (AppDomain.CurrentDomain != null);',
  '7:AQI=:y.txt:Monday:True');
const counter = 'UnityBridge.Test.' + randomUUID();
const code = `var key = "${counter}"; var n = SessionState.GetInt(key, 0) + 1; SessionState.SetInt(key, n); return n;`;
const id = randomUUID();
const first = await submit(editor.url, { code }, { id });
const duplicate = await submit(editor.url, { code }, { id });
assert.equal(first.result, '1'); assert.equal(duplicate.result, '1');
await assert.rejects(submit(editor.url, { code: 'return 99;' }, { id }), e => e.status === 409); checks.push('same-ID dedup and payload conflict');
const before = (await request(editor.url, '/api/health')).loadedSnippets;
await run('cached repeated snippet', 'return "cached";', 'cached');
await run('cached repeated snippet again', 'return "cached";', 'cached');
assert.equal((await request(editor.url, '/api/health')).loadedSnippets, before + 1);
const invalid = await submit(editor.url, { code: 'return not_a_declared_variable;' });
assert.equal(invalid.state, 'failed'); assert.match(invalid.error, /snippet.cs\(1,/); checks.push('source-mapped compilation failure');
const binary = await run('binary bytes', 'return new byte[]{0,1,2,255};'); assert.equal(binary.result, '@b64:AAEC/w==');
await run('Editor module and Engine module identity', 'var go = new GameObject("BridgeSmokeTemporary"); try { return typeof(SceneView).Name + ":" + go.transform.position.x; } finally { Object.DestroyImmediate(go); }', 'SceneView:0');
await run('Editor generic API references', 'return EditorWindow.HasOpenInstances<SceneView>().ToString();');
for (const operation of ['state', 'hierarchy', 'logs']) { assert.equal((await submit(editor.url, { operation })).state, 'succeeded'); checks.push(operation); }
const malformed = await fetch(editor.url + '/api/jobs', { method: 'POST', body: '{bad' }); assert.equal(malformed.status, 400);
const browser = await fetch(editor.url + '/api/health', { headers: { Origin: 'https://example.com' } }); assert.equal(browser.status, 403); checks.push('malformed JSON and browser origin rejected');
await assert.rejects(request(editor.url, '/api/jobs', { method: 'POST', body: { code: 'return 42;' }, projectPath: project + '-wrong' }), e => e.status === 409); checks.push('project identity guard');
console.log(JSON.stringify({ unity: editor.unity, checks, dedupId: id, endpoint: editor.url }, null, 2));

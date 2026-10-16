#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { connect, discover, request, submit, pollJob, checkedJob, saveBinary, BridgeError } from './client.mjs';

const help = `Unity Bridge 0.3.1 (Node 18+, localhost only)
  unity-bridge list
  unity-bridge health|state|hierarchy|logs|screenshot [options]
  unity-bridge exec --file snippet.cs | --code "return 42;" [options]
  unity-bridge status|wait|cancel <id> [options]
Options:
  --project <project-root>   Select/verify the exact Unity project
  --url <localhost-origin>  Select an explicit endpoint
  --id <id>                 Stable execution ID (otherwise generated)
  --no-wait                 Submit and return the ID immediately
  --timeout <seconds>       Wait budget, 1..300 (default 60)
  --queue-timeout <seconds> Queue deadline, 1..300 (default 30)
  --limit <n>               Hierarchy/log lines, 1..1000 (default 100)
  --output <path>           Save a binary result without printing base64
  --overwrite               Explicitly permit replacing the output file
Auth: optional UNITY_BRIDGE_TOKEN environment variable.
Exit codes: 0 success/accepted, 1 rejected/failed, 2 outcome unknown/pending.
Snippets are C# method bodies, not complete classes. Long/async Editor work
must be checked in later calls. A timeout never means a write was cancelled.`;

export function parse(args) {
  const options = {}, positional = [];
  const values = new Set(['project', 'url', 'id', 'file', 'code', 'timeout', 'queue-timeout', 'limit', 'output']);
  const flags = new Set(['no-wait', 'overwrite']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { positional.push(a); continue; }
    const key = a.slice(2);
    if (Object.hasOwn(options, key)) throw new BridgeError(`Duplicate option ${a}`);
    if (flags.has(key)) options[key] = true;
    else if (values.has(key) && args[i + 1] !== undefined) options[key] = args[++i];
    else throw new BridgeError(`Invalid option ${a}`);
  }
  for (const [key, min, max, fallback] of [['timeout', 1, 300, 60], ['queue-timeout', 1, 300, 30], ['limit', 1, 1000, 100]]) {
    const value = options[key] === undefined ? fallback : Number(options[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new BridgeError(`--${key} must be ${min}..${max}.`);
    options[key] = value;
  }
  return { options, positional };
}
export async function main(args = process.argv.slice(2)) {
  if (!args.length || args.includes('--help')) { console.log(help); return; }
  let endpoint, queriedId;
  const controller = new AbortController();
  const stopWaiting = () => controller.abort();
  process.once('SIGINT', stopWaiting); process.once('SIGTERM', stopWaiting);
  try {
    const { options: o, positional: [command, id, ...extra] } = parse(args);
    if (extra.length || (id && !['status', 'wait', 'cancel'].includes(command))) throw new BridgeError('Unexpected positional argument.');
    if (command === 'list') { console.log(JSON.stringify(await discover({ signal: controller.signal }), null, 2)); return; }
    if (!['health', 'state', 'hierarchy', 'logs', 'screenshot', 'exec', 'status', 'wait', 'cancel'].includes(command)) throw new BridgeError('Unknown command. Use --help.');
    if (command === 'exec' && (o.file === undefined) === (o.code === undefined)) throw new BridgeError('exec requires exactly one of --file or --code.');
    if (['status', 'wait', 'cancel'].includes(command) && !/^[A-Za-z0-9_-]{1,80}$/.test(id || '')) throw new BridgeError('A valid job ID is required.');
    if (['status', 'wait', 'cancel'].includes(command)) queriedId = id;
    endpoint = await connect({ ...o, signal: controller.signal });
    let result;
    if (command === 'health') result = endpoint;
    else {
      if (endpoint.protocol !== '2') throw new BridgeError('This client requires Unity Bridge 0.2.0/protocol 2. Update the UPM package first.');
      if (command === 'status' || command === 'cancel') {
        try { result = checkedJob(await request(endpoint.url, `/api/jobs/${id}`, { method: command === 'cancel' ? 'DELETE' : 'GET', projectPath: endpoint.projectPath, signal: controller.signal }), id); }
        catch (e) { throw new BridgeError(e.message, { id, state: 'unknown', executionMayHaveOccurred: true, status: e.status, exitCode: 2 }); }
      }
      else if (command === 'wait') result = await pollJob(endpoint.url, id, { timeoutMs: o.timeout * 1000, projectPath: endpoint.projectPath, signal: controller.signal });
      else {
        const code = command === 'exec' ? (o.file ? await readFile(o.file, 'utf8') : o.code) : undefined;
        if (code !== undefined && (!code.trim() || Buffer.byteLength(code, 'utf8') > 900000)) throw new BridgeError('Snippet must be non-empty and below 900 KB.');
        result = await submit(endpoint.url, { operation: command === 'exec' ? 'eval' : command, code, limit: o.limit, queueTimeoutMs: o['queue-timeout'] * 1000 },
          { id: o.id, wait: !o['no-wait'], timeoutMs: o.timeout * 1000, projectPath: endpoint.projectPath, signal: controller.signal, onId: jobId => console.error(`Unity Bridge job: ${jobId}`) });
      }
      result = await saveBinary(result, o.output, { overwrite: o.overwrite });
    }
    console.log(JSON.stringify(result, null, 2));
    if (['failed', 'cancelled', 'interrupted'].includes(result.state)) process.exitCode = 1;
  } catch (e) {
    const { message, stack, ...details } = e;
    if (queriedId && !details.id) Object.assign(details, { id: queriedId, state: 'unknown', executionMayHaveOccurred: true, exitCode: 2 });
    console.error(JSON.stringify({ error: message, endpoint: endpoint?.url, ...details }, null, 2));
    process.exitCode = details.exitCode || 1;
  } finally { process.removeListener('SIGINT', stopWaiting); process.removeListener('SIGTERM', stopWaiting); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

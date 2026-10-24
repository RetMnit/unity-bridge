// Isolated Editor only: stop twice, verify the watchdog leaves it stopped, restart.
import assert from 'node:assert/strict';
import { connect, request, submit } from '../plugins/unity-bridge/skills/unity-bridge/scripts/client.mjs';
const project=process.argv[2];
if(!project) throw new Error('Pass an isolated project root');
const editor=await connect({project});
const before=(await submit(editor.url,{operation:'logs',limit:1000})).result;
const count=(text,value)=>text.split(value).length-1;
const job=await submit(editor.url,{code:`
var startAfter = EditorApplication.timeSinceStartup + 2;
EditorApplication.CallbackFunction stop = null;
stop = () => {
    if(EditorApplication.timeSinceStartup < startAfter) return;
    EditorApplication.update -= stop;
    UnityBridge.UnityBridgeServer.Stop();
    UnityBridge.UnityBridgeServer.Stop();
    var until = EditorApplication.timeSinceStartup + 6;
    EditorApplication.CallbackFunction resume = null;
    resume = () => {
        if(EditorApplication.timeSinceStartup < until) return;
        EditorApplication.update -= resume;
        Debug.Log("StopSmoke remained stopped: " + (!UnityBridge.UnityBridgeServer.IsRunning()));
        UnityBridge.UnityBridgeServer.Start();
    };
    EditorApplication.update += resume;
}; EditorApplication.update += stop; return "stop-scheduled";`});
assert.equal(job.state,'succeeded');
let unavailable=false, restarted=false;
for(let i=0;i<120;i++){
  try{const response=await fetch(editor.url+'/api/health',{signal:AbortSignal.timeout(300)});if(!response.ok)throw new Error('offline');await response.text();if(unavailable){restarted=true;break;}}
  catch{unavailable=true;}
  await new Promise(r=>setTimeout(r,100));
}
assert(unavailable && restarted,'Did not observe stop followed by restart');
const after=(await submit(editor.url,{operation:'logs',limit:1000})).result;
for(const message of ['[Unity Bridge] Stopped.','[Unity Bridge] Already stopped.'])
  assert.equal(count(after,message)-count(before,message),1,message);
assert.match(after,/StopSmoke remained stopped: True/);
console.log(JSON.stringify({checks:['manual Stop logs once','repeated Stop logs already stopped','listener closes','watchdog respects Stop','Start restores service']}));

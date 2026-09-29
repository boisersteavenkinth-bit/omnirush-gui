import { app, net } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
const scriptIndex=process.argv.indexOf(fileURLToPath(import.meta.url));
if(scriptIndex<0) throw new Error("benchmark entry missing from argv");
const [variant, adapterPath, fixture, expectedHash, resultPath, profile] = process.argv.slice(scriptIndex+1);
app.setPath("userData",profile);
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("host-resolver-rules","MAP capture-bench.example.test 127.0.0.1");
async function run() {
const adapter=await import(pathToFileURL(adapterPath).href);
const started=performance.now();
const headers={"Content-Type":"application/zstd","X-OmniRush-Session-ID":"ses_transport_benchmark"};
const url="http://capture-bench.example.test:18692/collect";
let response;
if(variant==="baseline"){
  const compressed=await readFile(fixture);
  const transferred=new Uint8Array(compressed);
  const body=transferred.buffer.slice(transferred.byteOffset,transferred.byteOffset+transferred.byteLength);
  // Keep the two retry-owned copies alive, as worker and broker each do.
  globalThis.benchmarkRetryBodies=[compressed,transferred];
  response=await adapter.createExternalFetch({net})(url,{method:"POST",headers,body});
}else{
  response=await adapter.createExternalFileUpload({net})(url,{method:"POST",headers,path:fixture,size:32*1024*1024,signal:AbortSignal.timeout(60000)});
}
const result=await response.json();
if(response.status!==201||result.bytes!==32*1024*1024||result.sha256!==expectedHash) throw new Error("transport body mismatch");
await writeFile(resultPath,JSON.stringify({variant,status:response.status,bytes:result.bytes,sha256:result.sha256,elapsed_ms:Math.round(performance.now()-started),electron:process.versions.electron,node:process.versions.node},null,2));
globalThis.benchmarkRetryBodies=null;
app.quit();
}
app.whenReady().then(run).catch(error => { console.error(error); app.exit(1); });

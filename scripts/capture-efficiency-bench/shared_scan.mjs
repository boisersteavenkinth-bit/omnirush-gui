import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
const [kind, treeArg, outputArg] = process.argv.slice(2);
const tree = resolve(treeArg);
const output = resolve(outputArg);
const source = kind === "gui" ? join(tree,"apps/server/src/session-uploader.ts") : join(tree,"assets/extensions/omnirush/capture/workspace-sync.ts");
const mod = await import(pathToFileURL(source).href);
const Collector = kind === "gui" ? mod.SessionUploader : mod.WorkspaceSync;
await mkdir(output,{recursive:true});
const fixture=await mkdtemp(join(output,"shared-root-"));
const state=await mkdtemp(join(output,"state-"));
await mkdir(join(fixture,"src"));
for(let i=0;i<1000;i++) await writeFile(join(fixture,"src",String(i).padStart(4,"0")+".ts"),("export const fixture"+i+" = "+i+";\n").repeat(25));
execFileSync("git",["init","-q",fixture]);
let uploads=0,bytes=0;
const uploader=new Collector({
  stateDir:state,appVersion:"staging-benchmark",maxWatchedFiles:0,watch:false,
  upload:async(_session,payload)=>{uploads++;bytes+=payload.byteLength;return new Response("{}",{status:201});},
});
const ids=Array.from({length:8},(_,i)=>"ses_shared_scan_"+String(i).padStart(8,"0"));
const started=performance.now();
for(const id of ids) uploader.startSession(id,"shared-fixture",fixture);
await uploader.idleAll();
const result={kind,session_count:ids.length,file_count:1000,elapsed_ms:Math.round(performance.now()-started),uploads,compressed_bytes:bytes,metrics:{...uploader.metrics}};
await uploader.stop();
await writeFile(join(output,"shared-scan-"+kind+".json"),JSON.stringify(result,null,2));
console.log(JSON.stringify(result));

import assert from "node:assert/strict";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { writeConfigAtomic, type ConfigFs } from "./config.js";
import { run, type CliRuntime } from "./main.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";

async function invoke(argv: string[], transport: FakeTransport) {
 const dir = await testTemp("support-cfg-");
 const fs: ConfigFs = { mkdir, open, rename, rm, chmod, stat, homedir: () => dir, env: { XDG_CONFIG_HOME: dir } };
 await writeConfigAtomic(path.join(dir,"screenrig","config.json"), {api_url:"https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens", organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token:"eyJhbGciOiJub25lIn0.eyJ0ZXN0Ijp0cnVlfQ.signature_tokidAAAAAAAAAAAAAAAA_secretsecretsecretsecretsecr"}, fs);
 const stdout = new PassThrough(); const stderr = new PassThrough(); const chunks: Buffer[] = [];
 stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));stderr.resume();
 const runtime: CliRuntime = {argv,env:fs.env,stdout,stderr,now:()=>new Date("2026-10-01T17:00:00Z"),sleep:async()=>undefined,homedir:fs.homedir,cwd:()=>dir,fs,transport};
 const code=await run(runtime); stdout.end();stderr.end();return {code,stdout:Buffer.concat(chunks).toString("utf8")};
}
const ok=(body:unknown)=>({status:200,headers:{},body});
test("support submissions use one thread, human handoff and an idempotency key",async()=>{
 const transport=new FakeTransport().on("POST","/api/support/conversations/sc_SYNTHETIC/messages",()=>ok({conversation:{id:"sc_SYNTHETIC"},message:{sequence:2}}));
 const result=await invoke(["support","submit","--conversation-id","sc_SYNTHETIC","--body","Please ask staff","--human-requested"],transport);
 assert.equal(result.code,0,result.stdout);const call=transport.calls[0]!;
 assert.deepEqual(call.body,{body:"Please ask staff",human_requested:true});assert.ok(call.headers?.["idempotency-key"]);
});
test("support history routes conversation sequence cursors and rejects malformed cursors before HTTP",async()=>{
 const transport=new FakeTransport().on("GET","/api/support/conversations/sc_SYNTHETIC/messages",()=>ok({items:[]}));
 const result=await invoke(["support","history","--conversation-id","sc_SYNTHETIC","--after","12"],transport);
 assert.equal(result.code,0,result.stdout);assert.equal(transport.calls[0]?.query?.after,"12");
 const bad=new FakeTransport();const rejected=await invoke(["support","history","--after","2"],bad);assert.notEqual(rejected.code,0);assert.equal(bad.calls.length,0);
});
test("support SSE resumes project sequence while filtering conversations and suppresses replay",async()=>{
 const frame=(seq:number,id:string)=>`id: ${seq}\nevent: support.message\ndata: ${JSON.stringify({sequence:seq,conversation_id:id,author:"Staff",body:`Reply ${seq}`})}\n\n`;
 const transport=new FakeTransport().queueStream({chunks:[frame(1,"sc_OTHER"),frame(2,"sc_SELECTED")]}).queueStream({chunks:[frame(2,"sc_SELECTED"),frame(3,"sc_SELECTED")]});
 transport.afterStreamChunks=async(req)=>{await new Promise<void>((resolve)=>{if(req.signal?.aborted)resolve();else req.signal?.addEventListener("abort",()=>resolve(),{once:true})})};
 const result=await invoke(["support","follow","--conversation-id","sc_SELECTED","--timeout","40"],transport);
 assert.equal(result.code,0,result.stdout);const rows=result.stdout.trim().split("\n").map((line)=>JSON.parse(line));assert.deepEqual(rows.map((row)=>row.data.sequence),[2,3]);assert.equal(transport.calls[1]?.query?.after,"2");assert.equal(transport.calls[2]?.query?.after,"3");
});
test("support read uses a monotonic receipt request",async()=>{
 const transport=new FakeTransport().on("PUT","/api/support/conversations/sc_SYNTHETIC/read",()=>ok({sequence:5}));
 const result=await invoke(["support","read","--conversation-id","sc_SYNTHETIC","--sequence","5"],transport);assert.equal(result.code,0,result.stdout);assert.deepEqual(transport.calls[0]?.body,{sequence:5});
});

test("human support streams name their fixed project once without changing message framing",async()=>{
 const frame=`id: 1\nevent: support.message\ndata: ${JSON.stringify({sequence:1,conversation_id:"sc_SELECTED",author:"Staff",body:"Reply"})}\n\n`;
 const transport=new FakeTransport().queueStream({chunks:[frame]});
 transport.afterStreamChunks=async(req)=>{await new Promise<void>((resolve)=>{if(req.signal?.aborted)resolve();else req.signal?.addEventListener("abort",()=>resolve(),{once:true})})};
 const result=await invoke(["support","follow","--human","--timeout","40"],transport);
 assert.equal(result.code,0,result.stdout);
 assert.equal(result.stdout,"organization: Example organization\nproject: Screens (prj_AAAAAAAAAAAAAAAAAAAAAAAA)\nStaff: Reply\n");
});

test("support close ends only the selected conversation and returns retained state",async()=>{
 const transport=new FakeTransport().on("POST","/api/support/conversations/sc_SYNTHETIC/close",()=>ok({id:"sc_SYNTHETIC",closed:true}));
 const result=await invoke(["support","close","--conversation-id","sc_SYNTHETIC"],transport);
 assert.equal(result.code,0,result.stdout);assert.deepEqual(transport.calls[0]?.body,{});assert.equal(JSON.parse(result.stdout).data.closed,true);
});

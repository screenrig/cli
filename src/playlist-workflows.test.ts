import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { Writable, Readable } from "node:stream";
import { run, processRuntime } from "./main.js";
import { initializePlaylist, editablePlaylist, targetDimensions } from "./playlist-authoring.js";
import { FakeTransport } from "./transport/fake.js";
import { parseArgv } from "./argv.js";
import { publishScreen } from "./screen-publish.js";
import { ApiClient } from "./client.js";
import { networkError } from "./problems.js";
const media = [{ id: "med_IMAGE", primitive: "image", state: "ready" }, { id: "med_VIDEO", primitive: "video", state: "ready" }];
const document = () => initializePlaylist({ name: "Lobby", media, width: 1080, height: 1920, durationMs: 8000, fit: "contain" });
const response = (body: unknown) => ({ status: 200, headers: {}, body });

test("init preserves media order, portrait geometry and video completion", () => {
 const result = document();
 assert.equal(result.pages[0].canvas.height, 1920);
 assert.equal(result.pages[0].primitives[0].selector.media_id, "med_IMAGE");
 assert.deepEqual(result.pages[1].advance, { mode: "media_end" });
 assert.equal(result.pages[1].primitives[0].muted, true);
 assert.throws(() => targetDimensions({ observation: { surfaces: [{width:1,height:2},{width:2,height:1}] } }));
 assert.deepEqual(targetDimensions(undefined, 1920, 1080), {width:1920,height:1080});
 assert.throws(() => targetDimensions(undefined, 1920));
});

test("editable projection preserves dynamic selectors, schedules, motion and application pins", () => {
 const authored = document();
 authored.pages[0].primitives[0].selector = { by: "tag", tag: "lobby", one_at_a_time: true };
 authored.pages[0].primitives[0].motion = { type: "spin", direction: "cw", speed: "slow" };
 authored.pages[0].visibility = { enabled: true, from: "2026-09-10T09:00" };
 const app = structuredClone(authored.pages[1]); app.id = "app";
 app.advance = { mode: "application", max_ms: 10000 };
 app.primitives = [{id:"app",primitive:"application",controller:true,application_id:"app_TEST",release_id:"rel_TEST",rect:{x:0,y:0,width:1080,height:1920},layer:0,content_fit:"fill"}];
 authored.pages.push(app);
 const iframe = structuredClone(app); iframe.id="web"; iframe.advance={mode:"duration",after_ms:8000};
 iframe.primitives=[{id:"web",primitive:"iframe",src:"https://example.com",title:"Example",rect:{x:0,y:0,width:1080,height:1920},layer:0,content_fit:"fill"}];
 authored.pages.push(iframe);
 const resolved = structuredClone(authored);
 resolved.id="pl_TEST"; resolved.revision=3; resolved.comments={ note:"kept separately" };
 resolved.pages[0].primitives[0].resolved_media=[];
 resolved.pages[1].primitives[0].resolved_media=[];
 resolved.pages[1].primitives[0].selector.one_at_a_time=false;
 resolved.pages[1].advance.max_ms=12000;
 assert.deepEqual(editablePlaylist(resolved), authored);
 assert.equal(resolved.pages[1].advance.max_ms,12000);
 resolved.pages[0].unknown="unexpected";
 assert.throws(() => editablePlaylist(resolved));
});

test("revision aliases normalize, but duplicate spellings fail", () => {
 for(const flag of ["--expect-rev", "--if-match"]) assert.equal(parseArgv(["playlist","update","pl_TEST","x.json",flag,"3"]).flags["if-match"], "3");
 assert.equal(parseArgv(["playlist","update","pl_TEST","x.json","--if-match=3"]).flags["if-match"], "3");
 assert.throws(()=>parseArgv(["playlist","update","pl_TEST","x.json","--expect-rev","3","--if-match","3"]));
});

test("stdin validation and editable output need no jq or metadata stripping", async t => {
 const dir=await mkdtemp('/tmp/playlist-workflows-'); t.after(()=>rm(dir,{recursive:true,force:true}));
 const config=dir+'/config.json'; await writeFile(config,JSON.stringify({api_url:'https://api.screenrig.ai',token:'test-token'}),{mode:0o600});
 async function invoke(argv:string[], transport=new FakeTransport(), input=JSON.stringify(document())) {
  let out=''; const code=await run({...processRuntime(),argv:['--config',config,...argv],env:{},cwd:()=>dir,transport,stdin:Readable.from([input]),isStdinTty:()=>false,stdout:new Writable({write(c,e,done){out+=c;done();}}),stderr:new Writable({write(c,e,done){done();}})});
  return {code,body:JSON.parse(out)};
 }
 assert.equal((await invoke(['playlist','validate','-'])).code,0);
 assert.equal((await invoke(['playlist','validate','-'],undefined,'secret invalid JSON')).code,2);
 const transport=new FakeTransport().on('GET','/api/v1/playlists/pl_TEST',()=>response({...document(),id:'pl_TEST',revision:4}));
 const result=await invoke(['playlist','show','pl_TEST','--output','editable.json'],transport);
 assert.equal(result.code,0); assert.equal(result.body.data.revision,4);
 assert.deepEqual(JSON.parse(await readFile(dir+'/editable.json','utf8')),document());
 assert.equal((await invoke(['playlist','show','pl_TEST','--output','editable.json'],transport)).code,2);
 assert.throws(()=>parseArgv(['media','generate','--prompt','a','--prompt-file','b']));
});

for (const failure of ['create','assign','verify']) test(`publish resumes an ambiguous ${failure} without duplicating resources`, async t => {
 const dir=await mkdtemp('/tmp/publish-workflows-'); t.after(()=>rm(dir,{recursive:true,force:true}));
 let created=false, assigned=false, failed=false, reads=0;
 const createKeys:string[]=[],assignKeys:string[]=[];
 const transport=new FakeTransport()
 .on('GET','/api/v1/account',()=>response({id:'acc_TEST'}))
 .on('GET','/api/v1/screens/scr_TEST',()=>{
  reads++; if(failure==='verify'&&assigned&&!failed){failed=true;throw networkError('Test connection failure');}
  return response({id:'scr_TEST',revision:assigned?8:7,playlist_id:assigned?'pl_TEST':undefined});
 })
 .on('POST','/api/v1/playlists',req=>{
  createKeys.push(req.headers!['idempotency-key']!); created=true;
  if(failure==='create'&&!failed){failed=true;throw networkError('Test connection failure');}
  return response({id:'pl_TEST',revision:1});
 })
 .on('PATCH','/api/v1/screens/scr_TEST',req=>{
  assert.equal(req.headers!['if-match'],'"7"');assignKeys.push(req.headers!['idempotency-key']!);assigned=true;
  if(failure==='assign'&&!failed){failed=true;throw networkError('Test connection failure');}
  return response({id:'scr_TEST',revision:8,playlist_id:'pl_TEST'});
 });
 const options={client:new ApiClient({transport,token:'test-token'}),runtime:processRuntime(),configPath:dir+'/config.json',apiUrl:'https://api.screenrig.ai',screenId:'scr_TEST',revision:'7',document:document()};
 await assert.rejects(()=>publishScreen(options));
 const result=await publishScreen(options);
 assert.equal(result.assignment_verified,true); assert.equal(result.playback_verified,false);
 assert.equal(new Set(createKeys).size,1);assert.equal(new Set(assignKeys).size,1);
 await publishScreen(options);
 assert.equal(createKeys.length,failure==='create'?2:1);
 assert.equal(assignKeys.length,failure==='assign'?2:1);
 assert.ok(created&&assigned);
});

test("publish checks the expected screen revision before creating a playlist",async t=>{
 const dir=await mkdtemp('/tmp/publish-conflict-');t.after(()=>rm(dir,{recursive:true,force:true}));
 const transport=new FakeTransport().on('GET','/api/v1/account',()=>response({id:'acc_TEST'})).on('GET','/api/v1/screens/scr_TEST',()=>response({id:'scr_TEST',revision:9}));
 await assert.rejects(()=>publishScreen({client:new ApiClient({transport}),runtime:processRuntime(),configPath:dir+'/config.json',apiUrl:'https://api.screenrig.ai',screenId:'scr_TEST',revision:'7',document:document()}));
 assert.equal(transport.calls.some(c=>c.method!=='GET'),false);
});

test("init CLI writes a reusable document and prompt-file preserves exact text", async t => {
 const dir=await mkdtemp('/tmp/authoring-commands-');t.after(()=>rm(dir,{recursive:true,force:true}));
 const config=dir+'/config.json';await writeFile(config,JSON.stringify({api_url:'https://api.screenrig.ai',token:'test-token'}),{mode:0o600});
 const transport=new FakeTransport().on('GET','/api/v1/media/med_IMAGE',()=>response(media[0])).on('GET','/api/v1/media/med_VIDEO',()=>response(media[1]));
 async function invoke(argv:string[], input?:string) {
  let out=''; const code=await run({...processRuntime(),argv:['--config',config,...argv],env:{},cwd:()=>dir,transport,stdin:Readable.from([input??'']),isStdinTty:()=>false,stdout:new Writable({write(c,e,d){out+=c;d();}}),stderr:new Writable({write(c,e,d){d();}})});
  return {code,data:JSON.parse(out)};
 }
 const initialized=await invoke(['playlist','init','med_IMAGE','med_VIDEO','--name','Lobby','--output','lobby.json','--target-width','1080','--target-height','1920']);
 assert.equal(initialized.code,0,JSON.stringify(initialized.data));
 assert.equal(initialized.data.data.page_count,2);
 assert.deepEqual(JSON.parse(await readFile(dir+'/lobby.json','utf8')),document());
 assert.equal((await invoke(['playlist','validate','lobby.json'])).code,0);
 await writeFile(dir+'/prompt.txt',' exact copy\n');
 let seen='';transport.on('POST','/api/v1/media/generations',req=>{seen=(req.body as any).prompt;return {status:402,headers:{},body:{code:'payment_required',title:'Test refusal',detail:'Test',status:402}};});
 await invoke(['media','generate','--prompt-file','prompt.txt','--no-progress']);
 assert.equal(seen,' exact copy\n');
 assert.equal((await invoke(['media','generate','--prompt-file','-'], 'x'.repeat(4001))).code,2);
});

test("expired ambiguous publish journals never retry writes", async t => {
 const dir=await mkdtemp('/tmp/publish-expiry-');t.after(()=>rm(dir,{recursive:true,force:true}));
 let now=Date.now();
 const transport=new FakeTransport().on('GET','/api/v1/account',()=>response({id:'acc_TEST'})).on('GET','/api/v1/screens/scr_TEST',()=>response({id:'scr_TEST',revision:7})).on('POST','/api/v1/playlists',()=>{throw networkError('Test interruption');});
 const options={client:new ApiClient({transport}),runtime:{...processRuntime(),now:()=>new Date(now)},configPath:dir+'/config.json',apiUrl:'https://api.screenrig.ai',screenId:'scr_TEST',revision:'7',document:document()};
 await assert.rejects(()=>publishScreen(options));now+=24*60*60*1000;
 await assert.rejects(()=>publishScreen(options),/replay window has expired/);
 assert.equal(transport.calls.filter(c=>c.method==='POST').length,1);
});

test("assignment conflicts retain the created playlist and never create another on retry",async t=>{
 const dir=await mkdtemp('/tmp/publish-assignment-conflict-');t.after(()=>rm(dir,{recursive:true,force:true}));
 const transport=new FakeTransport().on('GET','/api/v1/account',()=>response({id:'acc_TEST'})).on('GET','/api/v1/screens/scr_TEST',()=>response({id:'scr_TEST',revision:7}))
 .on('POST','/api/v1/playlists',()=>response({id:'pl_TEST',revision:1}))
 .on('PATCH','/api/v1/screens/scr_TEST',()=>({status:409,headers:{},body:{code:'revision_conflict',title:'Conflict',status:409,detail:'Screen changed',current_revision:8}}));
 const options={client:new ApiClient({transport}),runtime:processRuntime(),configPath:dir+'/config.json',apiUrl:'https://api.screenrig.ai',screenId:'scr_TEST',revision:'7',document:document()};
 for(let i=0;i<2;i++) await assert.rejects(()=>publishScreen(options),(e:any)=>{assert.equal(e.problem.errors.at(-1).playlist_id,'pl_TEST');return true;});
 assert.equal(transport.calls.filter(c=>c.method==='POST').length,1);
});

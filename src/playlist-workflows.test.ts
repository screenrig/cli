import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { Writable, Readable } from "node:stream";
import { run, processRuntime } from "./main.js";
import { initializePlaylist, editablePlaylist, targetDimensions } from "./playlist-authoring.js";
import { FakeTransport, memoryBackend } from "./transport/fake.js";
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
 // The server reads back controller on every primitive and page comments.
 for (const page of resolved.pages) for (const primitive of page.primitives) primitive.controller ??= false;
 resolved.pages[0].comments={ note:"page note" };
 assert.deepEqual(editablePlaylist(resolved), authored);
 assert.equal(resolved.pages[1].advance.max_ms,12000);
 resolved.pages[0].unknown="unexpected";
 assert.throws(() => editablePlaylist(resolved));
});

test("init turns ready audio into the soundtrack and edits keep it", () => {
 const withAudio = initializePlaylist({ name: "Lobby", media: [media[0]!, { id: "med_SONG", primitive: "audio", state: "ready" }, media[1]!, { id: "med_BED", primitive: "audio", state: "ready" }], width: 1920, height: 1080, durationMs: 8000, fit: "contain" });
 assert.equal(withAudio.pages.length, 2);
 assert.deepEqual(withAudio.audio, { tracks: [{ id: "track_1", media_id: "med_SONG" }, { id: "track_2", media_id: "med_BED" }] });
 assert.throws(() => initializePlaylist({ name: "Only audio", media: [{ id: "med_SONG", primitive: "audio", state: "ready" }], width: 1920, height: 1080, durationMs: 8000, fit: "contain" }), /at least one page/);
 const read: Record<string, any> = { ...structuredClone(withAudio), id: "pl_TEST", revision: 2, audio: { ...withAudio.audio, loop: true, volume: 1 } };
 read.pages[0].audio_cue = { track: "track_2", restart: false };
 const editable = editablePlaylist(read);
 assert.deepEqual(editable.audio, { tracks: withAudio.audio.tracks, loop: true, volume: 1 });
 assert.deepEqual(editable.pages[0].audio_cue, { track: "track_2", restart: false });
});

test("editable stream preserves sources and fallback without resolved media", () => {
 const authored = document();
 authored.pages = [authored.pages[0]];
 authored.pages[0].primitives = [{ id: "live", primitive: "stream",
   sources: [{ protocol: "udp-mpegts", group: "239.10.0.1", port: 5000 }, { protocol: "hls", url: "https://example.com/live.m3u8" }],
   fallback_media_id: "med_IMAGE", muted: true,
   rect: { x: 0, y: 0, width: 1080, height: 1920 }, layer: 0, content_fit: "contain" }];
 const resolved = structuredClone(authored);
 resolved.pages[0].primitives[0].resolved_media = [{ media_id: "med_IMAGE" }];
 assert.deepEqual(editablePlaylist(resolved), authored);
 assert.equal(resolved.pages[0].primitives[0].resolved_media.length, 1);
});

test("revision aliases normalize, but duplicate spellings fail", () => {
 for(const flag of ["--expect-rev", "--if-match"]) assert.equal(parseArgv(["playlist","update","pl_TEST","x.json",flag,"3"]).flags["if-match"], "3");
 assert.equal(parseArgv(["playlist","update","pl_TEST","x.json","--if-match=3"]).flags["if-match"], "3");
 assert.throws(()=>parseArgv(["playlist","update","pl_TEST","x.json","--expect-rev","3","--if-match","3"]));
});

test("stdin validation and editable output need no jq or metadata stripping", async t => {
 const dir=await mkdtemp('/tmp/playlist-workflows-'); t.after(()=>rm(dir,{recursive:true,force:true}));
 const config=dir+'/config.json'; await writeFile(config,JSON.stringify({api_url:'https://api.screenrig.ai',project_id:'prj_AAAAAAAAAAAAAAAAAAAAAAAA',project_name:'Screens',organization_id:'org_AAAAAAAAAAAAAAAAAAAAAAAA',organization_name:'Example organization',token:'test-token'}),{mode:0o600});
 async function invoke(argv:string[], transport=new FakeTransport(), input=JSON.stringify(document())) {
  let out=''; const code=await run({...processRuntime(),argv:['--config',config,...argv],env:{},cwd:()=>dir,transport,stdin:Readable.from([input]),isStdinTty:()=>false,stdout:new Writable({write(c,e,done){out+=c;done();}}),stderr:new Writable({write(c,e,done){done();}})});
  return {code,body:JSON.parse(out)};
 }
 assert.equal((await invoke(['playlist','validate','-'])).code,0);
 assert.equal((await invoke(['playlist','validate','-'],undefined,'secret invalid JSON')).code,2);
 // Shaped like the server's read: resolved media and controller on every primitive.
 const read=document();
 for (const page of read.pages) for (const primitive of page.primitives) Object.assign(primitive,{controller:false,resolved_media:[{media_id:primitive.selector.media_id,intrinsic_size:{width:1080,height:1920}}]});
 const transport=new FakeTransport().on('GET','/api/playlists/pl_TEST',()=>response({...read,id:'pl_TEST',revision:4}));
 // An empty file left by an interrupted run does not block the retry.
 await writeFile(dir+'/editable.json','');
 const result=await invoke(['playlist','show','pl_TEST','--output','editable.json'],transport);
 assert.equal(result.code,0); assert.equal(result.body.data.revision,4);
 assert.deepEqual(JSON.parse(await readFile(dir+'/editable.json','utf8')),document());
 assert.equal((await invoke(['playlist','validate','editable.json'])).code,0);
 assert.equal((await invoke(['playlist','show','pl_TEST','--output','editable.json'],transport)).code,2);
 assert.throws(()=>parseArgv(['media','generate','--prompt','a','--prompt-file','b']));
});

for (const prefix of ["", "development_", "qa_", "stage_"]) for (const revision of [undefined, '7']) for (const failure of ['create','assign','verify']) test(`publish ${prefix || "production"} revision ${revision} resumes an ambiguous ${failure} without duplicating resources`, async t => {
 const dir=await mkdtemp('/tmp/publish-workflows-'); t.after(()=>rm(dir,{recursive:true,force:true}));
 let created=false, assigned=false, failed=false, reads=0;
 const createKeys:string[]=[],assignKeys:string[]=[];
 const transport=new FakeTransport()
 .on('GET','/api/project',()=>response({id:`${prefix}prj_TEST`}))
 .on('GET',`/api/screens/${prefix}scr_TEST`,()=>{
  reads++; if(failure==='verify'&&assigned&&!failed){failed=true;throw networkError('Test connection failure');}
  return response({id:`${prefix}scr_TEST`,revision:assigned?8:7,playlist_id:assigned?`${prefix}pl_TEST`:undefined});
 })
 .on('POST','/api/playlists',req=>{
  createKeys.push(req.headers!['idempotency-key']!); created=true;
  if(failure==='create'&&!failed){failed=true;throw networkError('Test connection failure');}
  return response({id:`${prefix}pl_TEST`,revision:1});
 })
 .on('PATCH',`/api/screens/${prefix}scr_TEST`,req=>{
  assert.equal(req.headers!['if-match'],revision ? '"7"' : undefined);assignKeys.push(req.headers!['idempotency-key']!);assigned=true;
  if(failure==='assign'&&!failed){failed=true;throw networkError('Test connection failure');}
  return response({id:`${prefix}scr_TEST`,revision:8,playlist_id:`${prefix}pl_TEST`});
 });
 const options={client:new ApiClient({transport,token:'test-token'}),runtime:processRuntime(),configPath:dir+'/config.json',apiUrl:'https://api.screenrig.ai',screenId:`${prefix}scr_TEST`,revision,document:document()};
 await assert.rejects(()=>publishScreen(options));
 const result=await publishScreen(options);
 assert.equal(result.assignment_verified,true); assert.equal(result.playback_verified,false);
 assert.equal(new Set(createKeys).size,1);assert.equal(new Set(assignKeys).size,1);
 await publishScreen(options);
 assert.equal(createKeys.length,failure==='create'?2:1);
 assert.equal(assignKeys.length,failure==='assign'?2:1);
 assert.ok(created&&assigned);
});

{
 const upgrade=(state:string,active:string|null,extra:Record<string,unknown>={})=>({desired_revision:'man_NEW',active_revision:active==='pl_TEST'?'man_NEW':active?'man_OLD':null,
  desired_playlist:{id:'pl_TEST',name:'Lobby',revision:1},active_playlist:active?{id:active,name:'Lobby',revision:1}:null,
  state,code:null,attempt:null,retry_at:null,missing_page_count:null,state_since:null,reported_at:null,...extra});
 const screen=(manifest_upgrade:unknown,extra:Record<string,unknown>={})=>({id:'scr_TEST',revision:8,playlist_id:'pl_TEST',online:true,
  effective_playlist:{id:'pl_TEST',source:'default'},manifest_upgrade,...extra});
 const cases:[string,unknown[],Record<string,unknown>][]=[
  ['plays once the Player acknowledges it',[screen(upgrade('pending','pl_OLD')),screen(upgrade('downloading','pl_OLD')),screen(upgrade('current','pl_TEST'))],{playing:true,state:'current',reads:3}],
  ['plays with missing pages when only part fits',[screen(upgrade('partial','pl_TEST',{missing_page_count:2}))],{playing:true,state:'partial',missing_page_count:2,reads:1}],
  ['stops at once for an offline screen',[screen(upgrade('pending','pl_OLD'),{online:false})],{playing:false,reason:'screen_offline',reads:1}],
  ['stops at once while a takeover shows another playlist',[screen(upgrade('current','pl_OLD'),{effective_playlist:{id:'pl_TAKEOVER',source:'takeover'}})],{playing:false,reason:'playlist_not_effective',effective_playlist_id:'pl_TAKEOVER',reads:1}],
  ['stops when the upgrade failed',[screen(upgrade('pending','pl_OLD')),screen(upgrade('failed','pl_OLD',{code:'storage_full'}))],{playing:false,reason:'playback_failed',code:'storage_full',reads:2}],
  ['reports the last state when the wait runs out',[screen(upgrade('downloading','pl_OLD'))],{playing:false,reason:'playback_pending',state:'downloading',waited_ms:10000}],
 ];
 for (const [name,reads,expected] of cases) test(`publish wait ${name}`,async t=>{
  const dir=await mkdtemp('/tmp/publish-wait-'); t.after(()=>rm(dir,{recursive:true,force:true}));
  let read=0,assigned=false,clock=0; const stages:string[]=[];
  const transport=new FakeTransport()
   .on('GET','/api/project',()=>response({id:'prj_TEST'}))
   .on('GET','/api/screens/scr_TEST',()=>response(assigned?reads[Math.min(read++,reads.length-1)]:{id:'scr_TEST',revision:7}))
   .on('POST','/api/playlists',()=>response({id:'pl_TEST',revision:1}))
   .on('PATCH','/api/screens/scr_TEST',()=>{assigned=true;return response({id:'scr_TEST',revision:8,playlist_id:'pl_TEST'});});
  const runtime={...processRuntime(),now:()=>new Date(clock),sleep:async(ms:number)=>{clock+=ms;}};
  const result=await publishScreen({client:new ApiClient({transport,token:'test-token'}),runtime,configPath:dir+'/config.json',apiUrl:'https://api.screenrig.ai',screenId:'scr_TEST',document:document(),
   wait:{timeoutMs:10000,pollMs:2000},progress:(stage,state)=>stages.push(`${stage}${state?`:${state}`:''}`)});
  const {reads:expectedReads,playing,...playback}=expected;
  assert.equal(result.stage,playing?'playing':'assigned'); assert.equal(result.playback_verified,playing);
  for (const [key,value] of Object.entries(playback)) assert.deepEqual((result.playback as any)[key],value,key);
  if (expectedReads!==undefined) assert.equal(read,expectedReads);
  assert.equal(stages.at(-1)?.startsWith(playing?'playing':'assigned'),true,stages.join());
 });
}

test("publish --no-wait returns after assignment and a wait warning explains the next step",async t=>{
 const dir=await mkdtemp('/tmp/publish-cli-'); t.after(()=>rm(dir,{recursive:true,force:true}));
 const config=dir+'/config.json'; await writeFile(config,JSON.stringify({api_url:'https://api.screenrig.ai',project_id:'prj_AAAAAAAAAAAAAAAAAAAAAAAA',project_name:'Screens',organization_id:'org_AAAAAAAAAAAAAAAAAAAAAAAA',organization_name:'Example organization',token:'test-token'}),{mode:0o600});
 await writeFile(dir+'/lobby.json',JSON.stringify(document()));
 let assigned=false;
 const transport=new FakeTransport()
  .on('GET','/api/project',()=>response({id:'prj_TEST'}))
  .on('GET','/api/screens/scr_TEST',()=>response(assigned?{id:'scr_TEST',revision:8,playlist_id:'pl_TEST',online:false}:{id:'scr_TEST',revision:7}))
  .on('POST','/api/playlists',()=>response({id:'pl_TEST',revision:1}))
  .on('PATCH','/api/screens/scr_TEST',()=>{assigned=true;return response({id:'scr_TEST',revision:8,playlist_id:'pl_TEST'});});
 async function invoke(...extra:string[]) {
  let out='',err='';const code=await run({...processRuntime(),argv:['--config',config,'screen','publish','scr_TEST','lobby.json',...extra],env:{XDG_CONFIG_HOME:dir},cwd:()=>dir,transport,sleep:async()=>{},
   stdout:new Writable({write(c,e,d){out+=c;d();}}),stderr:new Writable({write(c,e,d){err+=c;d();}})});
  return {code,body:JSON.parse(out),err};
 }
 const offline=await invoke();
 assert.equal(offline.code,0); assert.equal(offline.body.data.stage,'assigned');
 assert.deepEqual(offline.body.warnings.map((w:any)=>w.code),['screen_offline']);
 assert.match(offline.body.warnings[0].message,/Rerun the identical publish command/);
 assert.match(offline.err,/"event":"publish_stage","stage":"assigned"/);
 const unwaited=await invoke('--no-wait','--no-progress');
 assert.equal(unwaited.body.data.playback.reason,'not_waited'); assert.deepEqual(unwaited.body.warnings,[]); assert.equal(unwaited.err,'');
});

test("publish checks the expected screen revision before creating a playlist",async t=>{
 const dir=await mkdtemp('/tmp/publish-conflict-');t.after(()=>rm(dir,{recursive:true,force:true}));
 const transport=new FakeTransport().on('GET','/api/project',()=>response({id:'prj_TEST'})).on('GET','/api/screens/scr_TEST',()=>response({id:'scr_TEST',revision:9}));
 await assert.rejects(()=>publishScreen({client:new ApiClient({transport}),runtime:processRuntime(),configPath:dir+'/config.json',apiUrl:'https://api.screenrig.ai',screenId:'scr_TEST',revision:'7',document:document()}),
  (e:any)=>e.problem.code==='revision_conflict'&&e.problem.status===412&&e.exitCode===6&&e.problem.current_revision===9);
 assert.equal(transport.calls.some(c=>c.method!=='GET'),false);
});

test("init CLI writes a reusable document and prompt-file preserves exact text", async t => {
 const dir=await mkdtemp('/tmp/authoring-commands-');t.after(()=>rm(dir,{recursive:true,force:true}));
 const config=dir+'/config.json';await writeFile(config,JSON.stringify({api_url:'https://api.screenrig.ai',project_id:'prj_AAAAAAAAAAAAAAAAAAAAAAAA',project_name:'Screens',organization_id:'org_AAAAAAAAAAAAAAAAAAAAAAAA',organization_name:'Example organization',token:'test-token'}),{mode:0o600});
 const transport=new FakeTransport().on('GET','/api/media/med_IMAGE',()=>response(media[0])).on('GET','/api/media/med_VIDEO',()=>response(media[1]));
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
 let seen='';transport.on('POST','/api/media/generations',req=>{seen=(req.body as any).prompt;return {status:402,headers:{},body:{code:'payment_required',title:'Test refusal',detail:'Test',status:402}};});
 await invoke(['media','generate','--prompt-file','prompt.txt','--no-progress']);
 assert.equal(seen,' exact copy\n');
 assert.equal((await invoke(['media','generate','--prompt-file','-'], 'x'.repeat(4001))).code,2);
});

test("expired ambiguous publish journals never retry writes", async t => {
 const dir=await mkdtemp('/tmp/publish-expiry-');t.after(()=>rm(dir,{recursive:true,force:true}));
 let now=Date.now();
 const transport=new FakeTransport().on('GET','/api/project',()=>response({id:'prj_TEST'})).on('GET','/api/screens/scr_TEST',()=>response({id:'scr_TEST',revision:7})).on('POST','/api/playlists',()=>{throw networkError('Test interruption');});
 const options={client:new ApiClient({transport}),runtime:{...processRuntime(),now:()=>new Date(now)},configPath:dir+'/config.json',apiUrl:'https://api.screenrig.ai',screenId:'scr_TEST',revision:'7',document:document()};
 await assert.rejects(()=>publishScreen(options));now+=24*60*60*1000;
 await assert.rejects(()=>publishScreen(options),/replay window has expired/);
 assert.equal(transport.calls.filter(c=>c.method==='POST').length,1);
});

test("assignment conflicts retain the created playlist and never create another on retry",async t=>{
 const dir=await mkdtemp('/tmp/publish-assignment-conflict-');t.after(()=>rm(dir,{recursive:true,force:true}));
 const transport=new FakeTransport().on('GET','/api/project',()=>response({id:'prj_TEST'})).on('GET','/api/screens/scr_TEST',()=>response({id:'scr_TEST',revision:7}))
 .on('POST','/api/playlists',()=>response({id:'pl_TEST',revision:1}))
 .on('PATCH','/api/screens/scr_TEST',()=>({status:409,headers:{},body:{code:'revision_conflict',title:'Conflict',status:409,detail:'Screen changed',current_revision:8}}));
 const options={client:new ApiClient({transport}),runtime:processRuntime(),configPath:dir+'/config.json',apiUrl:'https://api.screenrig.ai',screenId:'scr_TEST',revision:'7',document:document()};
 for(let i=0;i<2;i++) await assert.rejects(()=>publishScreen(options),(e:any)=>{
  assert.equal(e.problem.errors.at(-1).playlist_id,'pl_TEST');
  assert.deepEqual(e.problem.next.argv,['screen','show','scr_TEST','--config',options.configPath,'--api-url',options.apiUrl]);
  assert.deepEqual(e.problem.next.after_inspection.argv,['screen','assign','scr_TEST','--playlist-id','pl_TEST','--expect-rev','<REVIEWED_REVISION>','--config',options.configPath,'--api-url',options.apiUrl]);
  assert.match(e.problem.next.reason,/Do not rerun publish with a new revision/);
  assert.match(e.problem.next.after_inspection.reason,/Only if this assignment is still intended/);
  // The placeholder cannot accidentally execute a write before reconciliation.
  assert.throws(()=>parseArgv(e.problem.next.after_inspection.argv));
  const reconciled=e.problem.next.after_inspection.argv.map((arg:string)=>arg==='<REVIEWED_REVISION>'?'8':arg);
  assert.equal(parseArgv(reconciled).flags['if-match'],'8');
  return true;
 });
 assert.equal(transport.calls.filter(c=>c.method==='POST').length,1);
 assert.equal(transport.calls.filter(c=>c.method==='GET'&&c.path==='/api/screens/scr_TEST').length,1);
 for(const call of transport.calls.filter(c=>c.method==='PATCH')) assert.equal(call.headers?.['if-match'],'"7"');
});

test("publish recovery arguments preserve paths with spaces without exposing URL credentials",async t=>{
 const dir=await mkdtemp('/tmp/publish guidance-');t.after(()=>rm(dir,{recursive:true,force:true}));
 const transport=new FakeTransport().on('GET','/api/project',()=>response({id:'prj_TEST'})).on('GET','/api/screens/scr_TEST',()=>response({id:'scr_TEST',revision:7}))
 .on('POST','/api/playlists',()=>response({id:'pl_TEST',revision:1}))
 .on('PATCH','/api/screens/scr_TEST',()=>({status:409,headers:{},body:{code:'revision_conflict',title:'Conflict',status:409,detail:'Screen changed',next:{command:'retry',reason:'Try again'}}}));
 const options={client:new ApiClient({transport,token:'private-test-token'}),runtime:processRuntime(),configPath:dir+'/selected config.json',apiUrl:'https://user:password@api.screenrig.ai/prefix?secret=value#private',screenId:'scr_TEST',revision:'7',document:document()};
 await assert.rejects(()=>publishScreen(options),(e:any)=>{
  for(const args of [e.problem.next.argv,e.problem.next.after_inspection.argv]) {
   assert.equal(args[args.indexOf('--config')+1],options.configPath);
   assert.equal(args[args.indexOf('--api-url')+1],'https://api.screenrig.ai/prefix');
  }
  assert.doesNotMatch(JSON.stringify(e.problem.next),/password|secret=value|private-test-token/);
  assert.equal(e.problem.next.after_inspection.argv.includes('7'),false);
  return true;
 });
});

for (const prefix of ["", "development_", "qa_", "stage_"]) test(`mixed preparation ${prefix || "production"} carries IDs unchanged`, async t => {
 const dir = await mkdtemp('/tmp/prepare mixed-'); t.after(() => rm(dir, {recursive:true,force:true}));
 const config = dir + '/config.json';
 await writeFile(config, JSON.stringify({api_url:'https://api.screenrig.ai',project_id:'prj_AAAAAAAAAAAAAAAAAAAAAAAA',project_name:'Screens',organization_id:'org_AAAAAAAAAAAAAAAAAAAAAAAA',organization_name:'Example organization',token:'test-token'}), {mode:0o600});
 let mediaState = "ready", targetId = `${prefix}scr_TEST`;
 const transport = new FakeTransport()
  .on('GET',`/api/screens/${prefix}scr_TEST`,()=>response({id:targetId,revision:7,observation:{surfaces:[{width:1080,height:1920}]}}))
  .on('GET','/api/media/med_IMAGE',()=>response({...media[0],state:mediaState}));
 async function invoke(inputs:string[], output='prepared.json') {
  let out=''; const code = await run({...processRuntime(),argv:['--config',config,'playlist','init',...inputs,'--name','Lobby','--screen',`${prefix}scr_TEST`,'--output',output],env:{},cwd:()=>dir,transport,
   stdout:new Writable({write(c,e,d){out+=c;d();}}),stderr:new Writable({write(c,e,d){d();}})});
  return {code,body:JSON.parse(out)};
 }
 const result = await invoke(['med_IMAGE',`${prefix}rel_TEST`,'https://example.com/board']);
 assert.equal(result.code,0,JSON.stringify(result.body));
 assert.equal(result.body.data.screen_id,`${prefix}scr_TEST`); assert.equal(result.body.data.screen_revision,7);
 const doc = JSON.parse(await readFile(dir+'/prepared.json','utf8'));
 assert.deepEqual(Object.keys(doc).sort(),['name','pages']);
 assert.deepEqual(doc.pages.map((p:any)=>p.primitives[0].primitive),['image','application','iframe']);
 assert.equal(doc.pages[1].primitives[0].release_id,`${prefix}rel_TEST`);
 assert.equal(doc.pages[1].primitives[0].content_fit,'fill');
 assert.deepEqual(doc.pages[1].advance,{mode:'duration',after_ms:8000});
 assert.equal(doc.pages[2].primitives[0].src,'https://example.com/board');
 const publish=parseArgv(result.body.data.publish.argv);
 assert.equal(publish.flags['if-match'],undefined); assert.equal(publish.positionals[3],dir+'/prepared.json');
 assert.equal(parseArgv(result.body.data.preview.argv).positionals[2],dir+'/prepared.json');
 assert.equal((await invoke(['https://user:secret@example.com'],'bad.json')).code,2);
 assert.equal((await invoke(['http://example.com'],'bad.json')).code,2);
 assert.equal((await invoke(['med_IMAGE'])).code,2);
 mediaState = 'processing';
 assert.equal((await invoke(['med_IMAGE'],'not-ready.json')).code,2);
 targetId = 'scr_OTHER';
 assert.equal((await invoke([`${prefix}rel_TEST`],'wrong-target.json')).code,2);
 assert.equal(transport.calls.some(c=>c.method!=='GET'),false);
});

test("file preparation uses upload readiness and protects existing output before remote writes", async t => {
 const dir=await mkdtemp('/tmp/prepare-upload-'); t.after(()=>rm(dir,{recursive:true,force:true}));
 const config=dir+'/config.json'; await writeFile(config,JSON.stringify({api_url:'https://api.screenrig.ai',project_id:'prj_AAAAAAAAAAAAAAAAAAAAAAAA',project_name:'Screens',organization_id:'org_AAAAAAAAAAAAAAAAAAAAAAAA',organization_name:'Example organization',token:'test-token'}),{mode:0o600});
 await writeFile(dir+'/poster.mp4',Buffer.from([0,0,0,24,102,116,121,112]));
 const transport=memoryBackend();
 let puts=0;
 async function invoke() {
  let out='';const code=await run({...processRuntime(),argv:['--config',config,'playlist','init','./poster.mp4','rel_TEST','--name','Lobby','--output','prepared.json','--target-width','1920','--target-height','1080','--no-transcode','--no-progress'],env:{},cwd:()=>dir,transport,sleep:async()=>{},signedRawPut:async()=>{puts++;return {status:200};},
   stdout:new Writable({write(c,e,d){out+=c;d();}}),stderr:new Writable({write(c,e,d){d();}})});
  return {code,body:JSON.parse(out)};
 }
 const result=await invoke();assert.equal(result.code,0,JSON.stringify(result.body));
 const doc=JSON.parse(await readFile(dir+'/prepared.json','utf8'));
 assert.equal(doc.pages[0].primitives[0].selector.media_id,'med_AAAAAAAAAAAAAAAAAAAAAAAA');
 assert.equal(doc.pages[1].primitives[0].release_id,'rel_TEST');
 assert.equal(result.body.data.publish,undefined); assert.equal(puts,1);
 assert.ok(transport.calls.some(c=>c.path.startsWith('/api/operations/')));
 assert.equal(transport.calls.some(c=>c.path==='/api/playlists'),false);
 const writes=transport.calls.filter(c=>c.method!=='GET').length;
 assert.equal((await invoke()).code,2);assert.equal(puts,1);
 assert.equal(transport.calls.filter(c=>c.method!=='GET').length,writes);
 await rm(dir+'/prepared.json');
 await rm(dir+'/poster.mp4');
 assert.equal((await invoke()).code,2);
 await assert.rejects(readFile(dir+'/prepared.json'));
});

test("file preparation recovers from an interrupted run: empty output is replaced and uploaded media is reused", async t => {
 const dir=await mkdtemp('/tmp/prepare-resume-'); t.after(()=>rm(dir,{recursive:true,force:true}));
 const config=dir+'/config.json'; await writeFile(config,JSON.stringify({api_url:'https://api.screenrig.ai',project_id:'prj_AAAAAAAAAAAAAAAAAAAAAAAA',project_name:'Screens',organization_id:'org_AAAAAAAAAAAAAAAAAAAAAAAA',organization_name:'Example organization',token:'test-token'}),{mode:0o600});
 await writeFile(dir+'/poster.mp4',Buffer.from([0,0,0,24,102,116,121,112]));
 // What an interrupted run of an earlier version left behind.
 await writeFile(dir+'/prepared.json','');
 const transport=memoryBackend();
 let puts=0;
 async function invoke(...extra:string[]) {
  let out='';const code=await run({...processRuntime(),argv:['--config',config,'playlist','init','./poster.mp4','rel_TEST','--name','Lobby','--output','prepared.json','--target-width','1920','--target-height','1080','--no-transcode','--no-progress',...extra],env:{},cwd:()=>dir,transport,sleep:async()=>{},signedRawPut:async()=>{puts++;return {status:200};},
   stdout:new Writable({write(c,e,d){out+=c;d();}}),stderr:new Writable({write(c,e,d){d();}})});
  return {code,body:JSON.parse(out)};
 }
 const first=await invoke(); assert.equal(first.code,0,JSON.stringify(first.body));
 assert.deepEqual(first.body.data.uploads.map((u:any)=>[u.source,u.media_id,u.reused]),[['./poster.mp4','med_AAAAAAAAAAAAAAAAAAAAAAAA',false]]);
 assert.equal(typeof first.body.data.uploads[0].timing.processing_ms,'number');
 const second=await invoke('--overwrite'); assert.equal(second.code,0,JSON.stringify(second.body));
 assert.equal(second.body.data.uploads[0].reused,true); assert.equal(puts,1);
 const doc=JSON.parse(await readFile(dir+'/prepared.json','utf8'));
 assert.equal(doc.pages[0].primitives[0].selector.media_id,'med_AAAAAAAAAAAAAAAAAAAAAAAA');
});

for (const sameFile of [false, true]) for (const explicitKey of [false, true]) {
 test(`file preparation isolates ${sameFile ? 'identical' : 'different'} declarations with ${explicitKey ? 'retry-stable explicit' : 'generated'} keys`, async t => {
  const dir = await mkdtemp('/tmp/prepare-idempotency-');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = dir + '/config.json';
  await writeFile(config, JSON.stringify({ api_url: 'https://api.screenrig.ai', project_id: 'prj_AAAAAAAAAAAAAAAAAAAAAAAA', project_name: 'Screens', organization_id: 'org_AAAAAAAAAAAAAAAAAAAAAAAA', organization_name: 'Example organization', token: 'test-token' }), { mode: 0o600 });
  await writeFile(dir + '/first.mp4', Buffer.from([0, 0, 0, 24, 102, 116, 121, 112]));
  await writeFile(dir + '/second.mp4', Buffer.from([0, 0, 0, 24, 102, 116, 121, 112, 1]));
  const declarations = new Map<string, { body: string; response: ReturnType<typeof response> }>();
  const commits = new Map<string, { path: string; body: string; response: ReturnType<typeof response> }>();
  let interrupted = false;
  const conflict = () => ({ status: 409, headers: {}, body: { code: 'idempotency_conflict', title: 'Conflict', status: 409 } });
  const transport = new FakeTransport()
   .on('POST', '/api/media/uploads', req => {
    const key = req.headers?.['idempotency-key']; assert.ok(key);
    const body = JSON.stringify(req.body);
    const cached = declarations.get(key);
    if (cached) return cached.body === body ? cached.response : conflict();
    const id = String(declarations.size + 1);
    const accepted = { status: 201, headers: { 'cache-control': 'private, no-store' }, body: {
     id: `upload_${id}`, operation: { id: `op_${id}` }, method: 'PUT', headers: {},
     upload_url: `https://storage.example.invalid/upload/${id}`, expires_at: '2099-01-01T00:00:00Z',
    } };
    declarations.set(key, { body, response: accepted });
    // Simulate acceptance followed by a lost response on the second file.
    if (explicitKey && id === '2' && !interrupted) { interrupted = true; throw networkError('Lost declaration response'); }
    return accepted;
   })
   .on('POST', /^\/api\/media\/uploads\/upload_\d+\/commit$/, req => {
    const key = req.headers?.['idempotency-key']; assert.ok(key);
    const body = JSON.stringify(req.body), cached = commits.get(key);
    if (cached) return cached.path === req.path && cached.body === body ? cached.response : conflict();
    const id = req.path.split('/').at(-2)!.slice('upload_'.length);
    const accepted = response({ id: `op_${id}`, state: 'succeeded', result: { media_id: `med_${id}` } });
    commits.set(key, { path: req.path, body, response: accepted });
    return accepted;
   })
   .on('GET', /^\/api\/operations\/op_\d+$/, req => {
    const id = req.path.split('/').at(-1)!.slice('op_'.length);
    return response({ id: `op_${id}`, state: 'succeeded', result: { media_id: `med_${id}` } });
   })
   .on('GET', /^\/api\/media\/med_\d+$/, req => response({ id: req.path.split('/').at(-1), state: 'ready', primitive: 'video' }));
  async function invoke() {
   let out = '';
   const code = await run({ ...processRuntime(), argv: ['--config', config,
    ...(explicitKey ? ['--idempotency-key', 'prepare-retry-test'] : []),
    'playlist', 'init', './first.mp4', sameFile ? './first.mp4' : './second.mp4',
    '--name', 'Lobby', '--output', 'prepared.json', '--target-width', '1920', '--target-height', '1080', '--no-transcode', '--no-progress'],
    env: {}, cwd: () => dir, transport, sleep: async () => {}, signedRawPut: async () => ({ status: 200 }),
    stdout: new Writable({ write(c, e, done) { out += c; done(); } }), stderr: new Writable({ write(c, e, done) { done(); } }),
   });
   return { code, body: JSON.parse(out) };
  }
  if (explicitKey) {
   const failed = await invoke(); assert.notEqual(failed.code, 0);
   assert.equal(interrupted, true, JSON.stringify(failed.body));
   await assert.rejects(readFile(dir + '/prepared.json'));
  }
  const result = await invoke(); assert.equal(result.code, 0, JSON.stringify(result.body));
  assert.equal(declarations.size, 2); assert.equal(commits.size, 2);
  assert.equal(new Set([...declarations.keys(), ...commits.keys()]).size, 4);
  // Files upload concurrently, so arrival order does not decide media IDs;
  // each page must still carry the media declared from its own file.
  const declaredBytes = new Map([...declarations.values()].map(({ body, response }) =>
   [`med_${(response.body as { id: string }).id.slice('upload_'.length)}`, JSON.parse(body).bytes]));
  const doc = JSON.parse(await readFile(dir + '/prepared.json', 'utf8'));
  assert.deepEqual(doc.pages.map((p: any) => declaredBytes.get(p.primitives[0].selector.media_id)), [8, sameFile ? 8 : 9]);
  assert.deepEqual(doc.pages.map((p: any) => p.primitives[0].selector.media_id).sort(), ['med_1', 'med_2']);
  const keys = transport.calls.filter(c => c.path === '/api/media/uploads').map(c => c.headers!['idempotency-key']);
  assert.equal(keys.length, explicitKey ? 4 : 2);
  if (explicitKey) {
   assert.deepEqual(keys.slice(0, 2).sort(), keys.slice(2).sort());
   // The upload that committed before the interruption replays its commit.
   const commitKeys = transport.calls.filter(c => c.path.endsWith('/commit')).map(c => c.headers!['idempotency-key']);
   assert.equal(commitKeys.length, 3); assert.equal(new Set(commitKeys).size, 2);
  }
 });
}

test("local URL authoring works offline, creates parents, and supports explicit overwrite", async t => {
 const dir=await mkdtemp('/tmp/offline-authoring-');t.after(()=>rm(dir,{recursive:true,force:true}));
 const output=dir+'/nested/playlist.json';
 async function invoke(extra:string[]=[]) {
  let out=''; const transport=new FakeTransport();
  const code=await run({...processRuntime(),argv:['--config',dir+'/config.json','playlist','init','https://example.com','--name','Offline','--target-width','1920','--target-height','1080','--output',output,...extra],env:{},cwd:()=>dir,transport,stdout:new Writable({write(c,e,d){out+=c;d();}}),stderr:new Writable({write(c,e,d){d();}})});
  assert.equal(transport.calls.length,0);return {code,out};
 }
 assert.equal((await invoke()).code,0);
 assert.equal((await invoke()).code,2);
 assert.equal((await invoke(['--overwrite'])).code,0);
 assert.equal(JSON.parse(await readFile(output,'utf8')).name,'Offline');
});

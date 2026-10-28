import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Writable,Readable} from 'node:stream';
import {run,processRuntime} from './main.js';
import {FakeTransport} from './transport/fake.js';

test('CLI sends card data with an expiry', async t => {
 const dir=await mkdtemp(path.join(tmpdir(),'screenrig-muse-')); t.after(()=>rm(dir,{recursive:true,force:true}));
 const config=path.join(dir,'config.json');
 await writeFile(config,JSON.stringify({api_url:'https://api.screenrig.ai',project_id:'prj_AAAAAAAAAAAAAAAAAAAAAAAA',project_name:'Screens',organization_name:'Example',organization_id:'org_AAAAAAAAAAAAAAAAAAAAAAAA',token:'test-token'}),{mode:0o600});
 const transport=new FakeTransport();
 const requests: {method:string;path:string;body?:any;headers?:Record<string,string>}[]=[];
 transport.on('PUT','/api/cards/crd_test/data',req=>{requests.push(req);return {status:200,headers:{},body:{key:'crd_test',revision:2,expires_at:'2026-10-20T19:30:00Z'}};});
 async function invoke(argv:string[],input?:string){let output='';const code=await run({...processRuntime(),argv:['--config',config,...argv],transport,cwd:()=>dir,env:{},stdin:Readable.from(input?[input]:[]),isStdinTty:()=>false,stdout:new Writable({write(c,_e,done){output+=c;done();}}),stderr:new Writable({write(_c,_e,done){done();}})});return {code,body:JSON.parse(output)};}
 const ttl=await invoke(['card','data','put','crd_test','--file','-','--ttl','30m'],'{"events":[]}');
 assert.equal(ttl.code,0,JSON.stringify(ttl.body));assert.deepEqual(requests[0]?.body,{document:{events:[]},ttl_seconds:1800});
});

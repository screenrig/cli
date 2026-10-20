import assert from "node:assert/strict";
import { access, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { withPreviewBrowser } from "./headless-preview.js";
import { testTemp } from "./test-temp.js";

const unix = { skip: process.platform === "win32" };
const HTML = "<!doctype html><html><body>Local preview</body></html>";

// A browser protocol peer lets us force startup failures and navigation ordering
// without depending on an installed browser, a display or a public renderer.
async function browserFixture(t: TestContext, mode = "render"): Promise<NodeJS.ProcessEnv> {
  const directory = await testTemp("preview-browser-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "browser.cjs");
  await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
const mode = ${JSON.stringify(mode)};
const profile = process.argv.find(arg => arg.startsWith('--user-data-dir=')).split('=').slice(1).join('=');
const send = value => fs.writeSync(4, JSON.stringify(value)+'\\0');
const event = (method, params) => send({method, params, sessionId:'session'});
if (mode === 'exit') { process.stderr.write('Chromium startup failed: sandbox unavailable\\n'); process.exit(1); }
let buffered='', loaded=false, foreground=false, intercepting=false, navigationUrl='', fulfilled=[];
fs.createReadStream(null,{fd:3}).on('data', chunk => {
  buffered+=chunk;
  let end;
  while ((end=buffered.indexOf('\\0'))>=0) {
    const message=JSON.parse(buffered.slice(0,end)); buffered=buffered.slice(end+1);
    const reply=result=>send({id:message.id,result});
    switch(message.method) {
      case 'Target.createTarget': reply({targetId:'target'}); break;
      case 'Target.attachToTarget': reply({sessionId:'session'}); break;
      case 'Page.bringToFront': foreground=true; reply({}); break;
      case 'Fetch.enable': intercepting=message.params.patterns.some(pattern=>pattern.urlPattern==='*'); reply({}); break;
      case 'Page.navigate':
        navigationUrl=message.params.url;
        // The reported browser blocks loopback even with the feature disabled.
        if (mode === 'local-network-checks' && message.params.url.startsWith('http://127.0.0.1')) {
          event('Network.requestWillBeSent',{requestId:'document',request:{url:message.params.url}});
          event('Network.loadingFailed',{requestId:'document',type:'Document',errorText:'net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS'});
          reply({errorText:'net::ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS'});
          break;
        }
        if (mode === 'private-resources' || mode === 'delivery-failure') {
          if (!intercepting) { reply({errorText:'net::ERR_NAME_NOT_RESOLVED'}); break; }
          reply({frameId:'frame',loaderId:'card'});
          for (const [requestId,url] of [['document',navigationUrl],['asset',navigationUrl+'cards/font.ttf?cache=1'],['missing',navigationUrl+'missing'],['external','https://example.test/private']]) {
            event('Fetch.requestPaused',{requestId,request:{url,method:'GET'}});
          }
          break;
        }
        event('Page.lifecycleEvent',{name:'load',frameId:'frame',loaderId:'about-blank'});
        if (mode==='early-load') {
          loaded=true;
          event('Page.lifecycleEvent',{name:'load',frameId:'frame',loaderId:'card'});
        }
        reply({frameId:'frame',loaderId:'card'});
        setTimeout(()=>{
          loaded=true;
          event('Page.lifecycleEvent',{name:'load',frameId:'frame',loaderId:'card'});
        },50);
        break;
      case 'Fetch.fulfillRequest':
        if (mode === 'delivery-failure') { send({id:message.id,error:{message:'interception failed'}}); break; }
        fulfilled.push(message.params);
        reply({});
        if (fulfilled.length === 4) {
          loaded=true;
          event('Page.lifecycleEvent',{name:'load',frameId:'frame',loaderId:'card'});
        }
        break;
      case 'Runtime.evaluate':
        if (!loaded || !foreground) { reply({exceptionDetails:{text:'Evaluated before card loaded in the foreground'}}); break; }
        if (mode === 'diagnostics') {
          event('Runtime.consoleAPICalled',{type:'error',args:[{value:'Renderer failed: sr_live_identifier_supersecret'}]});
          event('Runtime.exceptionThrown',{exceptionDetails:{exception:{description:'TypeError: renderer is unavailable'}}});
          event('Network.requestWillBeSent',{requestId:'asset',request:{url:'https://user:password@example.test/renderer.js?signature=private#secret'}});
          event('Network.loadingFailed',{requestId:'asset',type:'Script',errorText:'net::ERR_FAILED',blockedReason:'csp'});
          event('Network.responseReceived',{response:{url:'https://example.test/fonts.ttf?token=private',status:404}});
          reply({exceptionDetails:{text:'Card did not render'}});
        } else reply({result:{value:{pid:process.pid,profile,args:process.argv.slice(2),navigationUrl,fulfilled}}});
        break;
      case 'Page.captureScreenshot': reply({data:Buffer.from('png').toString('base64')}); break;
      default: reply({});
    }
  }
});
`, { mode: 0o700 });
  return { ...process.env, TMPDIR: directory, SCREENRIG_BROWSER: binary };
}

test("preview waits for its document and brings it forward before rendering", unix, async t => {
  if (process.getuid) t.mock.method(process as NodeJS.Process & { getuid(): number }, "getuid", () => 1000);
  for (const mode of ["render", "early-load"]) {
    const env = await browserFixture(t, mode);
    const result = await withPreviewBrowser(env, browser => browser.render(HTML, 320, 180));
    assert.equal(result.png.toString(), "png");
    assert.ok(!result.result.args.includes("--no-sandbox"), "ordinary users retain Chromium's sandbox");
    assert.throws(() => process.kill(result.result.pid, 0), { code: "ESRCH" }, "browser must be reaped");
    await assert.rejects(access(result.result.profile), { code: "ENOENT" });
  }
});

test("root preview starts Chromium with its required sandbox flag", unix, async t => {
  if (process.getuid) t.mock.method(process as NodeJS.Process & { getuid(): number }, "getuid", () => 0);
  const result = await withPreviewBrowser(await browserFixture(t), browser => browser.render(HTML, 320, 180));
  assert.ok(result.result.args.includes("--no-sandbox"));
});

test("preview avoids loopback even when Chromium ignores the local-network feature flag", unix, async t => {
  for (const uid of [1000, 0]) {
    if (process.getuid) t.mock.method(process as NodeJS.Process & { getuid(): number }, "getuid", () => uid);
    const result = await withPreviewBrowser(await browserFixture(t, "local-network-checks"), browser => browser.render(HTML, 320, 180));
    assert.equal(result.png.toString(), "png");
    assert.equal(result.result.navigationUrl, "https://screenrig-preview.invalid/");
    assert.equal(result.result.args.includes("--no-sandbox"), uid === 0);
    assert.ok(!result.result.args.includes("--disable-web-security"));
    assert.ok(!result.result.args.some((arg: string) => arg.includes("LocalNetworkAccessChecks")));
    assert.throws(() => process.kill(result.result.pid, 0), { code: "ESRCH" });
    await assert.rejects(access(result.result.profile), { code: "ENOENT" });
  }
});

test("preview delivers the document and binary assets privately, retaining CSP and refusing unknown resources", unix, async t => {
  const bytes = Buffer.from([255, 0, 127]);
  const assets = new Map([["/cards/font.ttf", { bytes, type: "font/ttf" }]]);
  const result = await withPreviewBrowser(await browserFixture(t, "private-resources"), browser => browser.render(HTML, 320, 180, assets));
  const responses = new Map<string, any>(result.result.fulfilled.map((response: any) => [response.requestId, response]));
  const document = responses.get("document");
  assert.equal(document.responseCode, 200);
  assert.equal(Buffer.from(document.body, "base64").toString(), HTML);
  assert.match(document.responseHeaders.find((header: any) => header.name === "Content-Security-Policy").value, /connect-src 'none'/);
  assert.equal(responses.get("asset").responseCode, 200);
  assert.deepEqual(Buffer.from(responses.get("asset").body, "base64"), bytes);
  for (const name of ["missing", "external"]) {
    assert.equal(responses.get(name).responseCode, 404);
    assert.equal(responses.get(name).body, "");
  }
});

test("private resource delivery failure rejects promptly and removes the browser profile", unix, async t => {
  const env = await browserFixture(t, "delivery-failure");
  const started = Date.now();
  await assert.rejects(withPreviewBrowser(env, browser => browser.render(HTML, 320, 180)), /interception failed/);
  assert.ok(Date.now() - started < 5000);
  assert.ok(!(await readdir(env.TMPDIR!)).some(name => name.startsWith("screenrig-preview-")));
});

test("real Chromium renders scripts, images and a worker with all browser networking unavailable", { skip: process.platform === "win32" || !process.env.SCREENRIG_TEST_BROWSER }, async t => {
  const directory = await testTemp("preview-offline-");
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binary = process.env.SCREENRIG_TEST_BROWSER!;
  await access(binary);
  const wrapper = path.join(directory, "offline-browser");
  const quoted = "'" + binary.replace(/'/g, "'\\''") + "'";
  await writeFile(wrapper, `#!/bin/sh\nexec ${quoted} --proxy-server=http://127.0.0.1:1 '--proxy-bypass-list=<-loopback>' "$@"\n`, { mode: 0o700 });
  const assets = new Map([
    ["/ready.js", { type: "text/javascript", bytes: Buffer.from("const worker=new Worker('/worker.js');worker.onmessage=async e=>{const image=document.querySelector('img');await image.decode();window.previewResult={worker:e.data,imageWidth:image.naturalWidth};window.previewReady=true}") }],
    ["/worker.js", { type: "text/javascript", bytes: Buffer.from("postMessage('ready')") }],
    ["/image.svg", { type: "image/svg+xml", bytes: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><path fill="red" d="M0 0h8v8H0z"/></svg>') }],
  ]);
  const html = '<!doctype html><body><img src="/image.svg"><script src="/ready.js"></script>';
  const result = await withPreviewBrowser({ ...process.env, TMPDIR: directory, SCREENRIG_BROWSER: wrapper }, browser => browser.render(html, 320, 180, assets));
  assert.deepEqual(result.result, { worker: "ready", imageWidth: 8 });
  assert.deepEqual(result.png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
});

test("startup failure rejects promptly, including when the browser exits before work", unix, async t => {
  for (const delay of [0, 100]) {
    const env = await browserFixture(t, "exit");
    const started = Date.now();
    await assert.rejects(withPreviewBrowser(env, async browser => {
      await new Promise(resolve => setTimeout(resolve, delay));
      return browser.render(HTML, 320, 180);
    }), /Local preview browser stopped/);
    assert.ok(Date.now() - started < 5000, "startup failure must not wait for a protocol timeout");
    assert.ok(!(await readdir(env.TMPDIR!)).some(name => name.startsWith("screenrig-preview-")));
  }
});

test("render failures include console, exception and resource causes without credentials", unix, async t => {
  await assert.rejects(withPreviewBrowser(await browserFixture(t, "diagnostics"), browser => browser.render(HTML, 320, 180)), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Card did not render/);
    assert.match(error.message, /Renderer failed: sr_live_\*\*\*/);
    assert.match(error.message, /TypeError: renderer is unavailable/);
    assert.match(error.message, /Resource failed: https:\/\/example.test\/renderer.js: net::ERR_FAILED \(csp\)/);
    assert.match(error.message, /HTTP 404: https:\/\/example.test\/fonts.ttf/);
    assert.doesNotMatch(error.message, /password|signature|private|#secret|supersecret|identifier/);
    return true;
  });
});

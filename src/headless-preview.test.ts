import assert from "node:assert/strict";
import { access, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { withPreviewBrowser } from "./headless-preview.js";
import { testTemp } from "./test-temp.js";

const unix = { skip: process.platform === "win32" };

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
let buffered='', loaded=false, foreground=false;
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
      case 'Page.navigate':
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
      case 'Runtime.evaluate':
        if (!loaded || !foreground) { reply({exceptionDetails:{text:'Evaluated before card loaded in the foreground'}}); break; }
        if (mode === 'diagnostics') {
          event('Runtime.consoleAPICalled',{type:'error',args:[{value:'Renderer failed: sr_live_identifier_supersecret'}]});
          event('Runtime.exceptionThrown',{exceptionDetails:{exception:{description:'TypeError: renderer is unavailable'}}});
          event('Network.requestWillBeSent',{requestId:'asset',request:{url:'https://user:password@example.test/renderer.js?signature=private#secret'}});
          event('Network.loadingFailed',{requestId:'asset',type:'Script',errorText:'net::ERR_FAILED',blockedReason:'csp'});
          event('Network.responseReceived',{response:{url:'https://example.test/fonts.ttf?token=private',status:404}});
          reply({exceptionDetails:{text:'Card did not render'}});
        } else reply({result:{value:{pid:process.pid,profile,args:process.argv.slice(2)}}});
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
    const result = await withPreviewBrowser(env, browser => browser.render("http://127.0.0.1/", 320, 180));
    assert.equal(result.png.toString(), "png");
    assert.ok(!result.result.args.includes("--no-sandbox"), "ordinary users retain Chromium's sandbox");
    assert.throws(() => process.kill(result.result.pid, 0), { code: "ESRCH" }, "browser must be reaped");
    await assert.rejects(access(result.result.profile), { code: "ENOENT" });
  }
});

test("root preview starts Chromium with its required sandbox flag", unix, async t => {
  if (process.getuid) t.mock.method(process as NodeJS.Process & { getuid(): number }, "getuid", () => 0);
  const result = await withPreviewBrowser(await browserFixture(t), browser => browser.render("http://127.0.0.1/", 320, 180));
  assert.ok(result.result.args.includes("--no-sandbox"));
});

test("startup failure rejects promptly, including when the browser exits before work", unix, async t => {
  for (const delay of [0, 100]) {
    const env = await browserFixture(t, "exit");
    const started = Date.now();
    await assert.rejects(withPreviewBrowser(env, async browser => {
      await new Promise(resolve => setTimeout(resolve, delay));
      return browser.render("http://127.0.0.1/", 320, 180);
    }), /Local preview browser stopped/);
    assert.ok(Date.now() - started < 5000, "startup failure must not wait for a protocol timeout");
    assert.ok(!(await readdir(env.TMPDIR!)).some(name => name.startsWith("screenrig-preview-")));
  }
});

test("render failures include console, exception and resource causes without credentials", unix, async t => {
  await assert.rejects(withPreviewBrowser(await browserFixture(t, "diagnostics"), browser => browser.render("http://127.0.0.1/", 320, 180)), (error: unknown) => {
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

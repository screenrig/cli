import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { installSource } from "./install-source.js";

const pluginChunk = pathToFileURL("/home/user/.claude/plugins/cache/screenrig/screenrig/26.10.1/cli/dist/chunk-ABC.js").href;
const npmModule = pathToFileURL("/usr/lib/node_modules/screenrig/dist/install-source.js").href;

test("the plugin helper's install source is reported when it has the accepted shape", () => {
  assert.equal(installSource({ SCREENRIG_INSTALL_SOURCE: "claude/screenrig" }, pluginChunk), "claude/screenrig");
  assert.equal(installSource({ SCREENRIG_INSTALL_SOURCE: " codex/claude-plugins.official " }, pluginChunk), "codex/claude-plugins.official");
  assert.equal(installSource({ SCREENRIG_INSTALL_SOURCE: "grok" }, pluginChunk), "grok");
  for (const value of ["", "Claude/screenrig", "claude/", "claude/Screen Rig", "claude/screenrig/extra", "sr_live_AAAA", `claude/${"a".repeat(65)}`]) {
    assert.equal(installSource({ SCREENRIG_INSTALL_SOURCE: value }, pluginChunk), undefined, value);
  }
});

test("the npm package reports npm; a plugin or source checkout without the helper's value reports nothing", () => {
  assert.equal(installSource({}, npmModule), "npm");
  assert.equal(installSource({ SCREENRIG_INSTALL_SOURCE: "claude/screenrig" }, npmModule), "claude/screenrig");
  assert.equal(installSource({}, pluginChunk), undefined);
  assert.equal(installSource({}, pathToFileURL("/home/user/src/cli/dist/install-source.js").href), undefined);
});

import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { decodeAttributeEntities, iframeSnippetSource } from "./iframe-snippet.js";
import { processRuntime, run } from "./main.js";
import { testTemp } from "./test-temp.js";
import { FakeTransport } from "./transport/fake.js";

const PUBLISHED = "https://docs.google.com/presentation/d/e/2PACX-1vTestPublishedIdentifier_0123456789abcdefghijklmnop/embed?start=true&loop=true&delayms=3000";
const BOARD = "https://example.com/correct?x=1&y=2";
const QUOTED_EMBEDS = [
  `<iframe title="Sales > last week" src="${BOARD}"></iframe>`,
  `<iframe title="Address example src='https://example.com/wrong'" src="${BOARD}"></iframe>`,
  `<iframe title='Sales > last week; src="https://example.com/wrong"' src='${BOARD}'></iframe>`,
];

test("an embed code gives the src of its first iframe", () => {
  const cases: [string, string | undefined][] = [
    [`<iframe src="${PUBLISHED.replaceAll("&", "&amp;")}" frameborder="0" width="960" height="569" allowfullscreen="true"></iframe>`, PUBLISHED],
    [`  <iframe width='402' src='${PUBLISHED}'></iframe>`, PUBLISHED],
    [`<iframe src=${PUBLISHED} width=402></iframe>`, PUBLISHED],
    [`<IFRAME\n  WIDTH="402"\n  SRC="${PUBLISHED}"\n></IFRAME>`, PUBLISHED],
    [`<iframe data-src="https://example.com/no" src="https://example.com/yes"></iframe><iframe src="https://example.com/two"></iframe>`, "https://example.com/yes"],
    [`<iframe src="https://example.com/a?x&#61;1&#x26;y=2"></iframe>`, "https://example.com/a?x=1&y=2"],
    // Anything that does not start with an iframe tag is not an embed code.
    [PUBLISHED, undefined],
    ["https://example.com/<iframe src=\"https://example.com/no\">", undefined],
    ["med_AAAAAAAAAAAAAAAAAAAAAAAA", undefined],
    ["./slides.png", undefined],
  ];
  for (const [input, want] of cases) assert.equal(iframeSnippetSource(input), want, input);
  for (const input of QUOTED_EMBEDS) assert.equal(iframeSnippetSource(input), BOARD, input);
});

test("an embed code with no src is a usage error", () => {
  for (const input of [
    `<iframe width="400"></iframe>`, `<iframe src=""></iframe>`, `<iframe src="  "></iframe>`,
    `<iframe title="Example src='https://example.com/wrong'"></iframe>`,
    `<iframe title="No source"></iframe><iframe src="${BOARD}"></iframe>`,
    `<iframe title="Unclosed src='https://example.com/wrong'></iframe>`,
  ]) {
    assert.throws(() => iframeSnippetSource(input), /no src address/, input);
  }
});

test("character references are decoded once and only the ones an attribute carries", () => {
  assert.equal(decodeAttributeEntities("a&amp;b&lt;c&gt;d&quot;e&apos;f"), `a&b<c>d"e'f`);
  assert.equal(decodeAttributeEntities("&amp;amp;"), "&amp;");
  assert.equal(decodeAttributeEntities("&#38;&#x26;&#0;&#1114112;&nbsp;&bogus;"), "&&&#0;&#1114112;&nbsp;&bogus;");
});

async function initInvoke(args: string[]) {
  const dir = await testTemp("iframe-snippet-");
  const config = path.join(dir, "config.json");
  await writeFile(config, JSON.stringify({
    api_url: "https://api.screenrig.ai", project_id: "prj_AAAAAAAAAAAAAAAAAAAAAAAA", project_name: "Screens",
    organization_id: "org_AAAAAAAAAAAAAAAAAAAAAAAA", organization_name: "Example organization", token: "test-token",
  }), { mode: 0o600 });
  const stdout = new PassThrough(), stderr = new PassThrough();
  const chunks: Buffer[] = [];
  stdout.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  const code = await run({ ...processRuntime(), argv: ["--config", config, "--json", "playlist", "init", ...args, "--name", "Lobby", "--output", "out.json", "--target-width", "1920", "--target-height", "1080"], env: {}, cwd: () => dir, transport: new FakeTransport(), stdout, stderr });
  return { dir, code, stdout: Buffer.concat(chunks).toString("utf8"), cleanup: () => rm(dir, { recursive: true, force: true }) };
}

test("playlist init turns a pasted embed code into an iframe page", async (t) => {
  const result = await initInvoke([`<iframe src="${PUBLISHED.replaceAll("&", "&amp;")}" width="960" height="569"></iframe>`, "https://example.com/board"]);
  t.after(result.cleanup);
  assert.equal(result.code, 0, result.stdout);
  const document = JSON.parse(await readFile(path.join(result.dir, "out.json"), "utf8"));
  const sources = document.pages.map((page: any) => page.primitives[0]);
  assert.deepEqual(sources.map((primitive: any) => [primitive.primitive, primitive.src, primitive.title]), [
    ["iframe", PUBLISHED, "docs.google.com"],
    ["iframe", "https://example.com/board", "example.com"],
  ]);
});

test("playlist init uses the iframe source after quoted title text", async (t) => {
  const result = await initInvoke(QUOTED_EMBEDS);
  t.after(result.cleanup);
  assert.equal(result.code, 0, result.stdout);
  const document = JSON.parse(await readFile(path.join(result.dir, "out.json"), "utf8"));
  assert.deepEqual(document.pages.map((page: any) => page.primitives[0].src), [BOARD, BOARD, BOARD]);
});

test("playlist init refuses an embed code with no usable address", async (t) => {
  for (const input of [`<iframe width="400"></iframe>`, `<iframe src="javascript:alert(1)"></iframe>`, `<iframe src="not a url"></iframe>`]) {
    const result = await initInvoke([input]);
    t.after(result.cleanup);
    assert.equal(result.code, 2, `${input}: ${result.stdout}`);
    assert.equal(JSON.parse(result.stdout).error.code, "usage_error");
  }
});

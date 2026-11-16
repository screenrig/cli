import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiClient } from "./client.js";
import { validatePlaylistCards, type CardDetails } from "./cards.js";
import { CONTAINER_EXAMPLE } from "./cli-commands/guidance-text.js";
import { editablePlaylist } from "./playlist-authoring.js";
import { authoringPage } from "./playlist-page.js";
import { playlistIssues } from "./playlist-validate.js";
import { assertWirePages, flatPrimitives, validatePlaylistWrite } from "./playlist-write-validation.js";
import { FakeTransport } from "./transport/fake.js";

type Doc = Record<string, any>;

const textItem = (id: string, extra: Doc = {}) => ({ id, primitive: "card", card: "text", major: 1, params: { title: id }, layout: "full", ...extra });

/** An L-bar: a video, a side container that follows it, a corner container on the clock and a card reading the clip's record. */
function lbar(edit: (page: Doc) => void = () => undefined): Doc {
  const page: Doc = {
    id: "lbar",
    canvas: { width: 1920, height: 1080, background: "#000000FF" },
    transition: { type: "crossfade", duration_ms: 400 },
    advance: { mode: "media_end" },
    primitives: [
      { id: "a", primitive: "video", selector: { by: "ids", media_ids: ["med_one", "med_two"] }, rect: { x: 0, y: 0, width: 1440, height: 810 }, layer: 0, content_fit: "cover", muted: true, loop: false },
      {
        id: "b", primitive: "container", rect: { x: 1440, y: 0, width: 480, height: 810 }, layer: 1,
        turn: { on: "video", every_ms: 12000, match: "tag", no_match: "clock", min_ms: 4000 },
        transition: { type: "fade", duration_ms: 400 },
        items: [
          textItem("b_city", { tags: ["city"] }),
          { id: "b_photo", primitive: "image", selector: { by: "id", media_id: "med_photo" }, content_fit: "cover", tags: ["travel"] },
          textItem("b_last", { when: { data: { key: "{page.video}", path: "/lap", equals: 3 } } }),
        ],
      },
      { id: "c", primitive: "card", card: "text", major: 1, params: {}, data: "{page.video}", layout: "free", rect: { x: 0, y: 810, width: 1440, height: 270 }, layer: 2, content_fit: "fill" },
      { id: "d", primitive: "container", rect: { x: 1440, y: 810, width: 480, height: 270 }, layer: 3, turn: { on: "clock", every_ms: 8000, offset_ms: 4000 }, items: [textItem("d_one"), textItem("d_two")] },
    ],
  };
  edit(page);
  return { name: "L-bar", pages: [page, { ...structuredClone(page), id: "later", visibility: { enabled: true, data: { key: "{page.video}", path: "/index", equals: 0 } } }] };
}

const paths = (document: unknown) => playlistIssues(document).map((issue) => `${issue.path} ${issue.message}`);

test("a container page validates: clock and video turns, image and card items, tags, when and {page.video}", () => {
  const document = lbar();
  assertWirePages(document.pages);
  assert.deepEqual(paths(document), []);
  // The help's example validates on a page of its own.
  const example = lbar((page) => { page.advance = { mode: "duration", after_ms: 10000 }; page.primitives = [structuredClone(CONTAINER_EXAMPLE)]; });
  example.pages.pop();
  assert.deepEqual(paths(example), []);
  assert.deepEqual(flatPrimitives(document.pages[0].primitives).map((entry) => entry.at).slice(0, 5),
    ["primitives[0]", "primitives[1]", "primitives[1].items[0]", "primitives[1].items[1]", "primitives[1].items[2]"]);
});

test("container refusals follow the backend's rules and paths", () => {
  const refused = (edit: (page: Doc) => void, expected: RegExp) => {
    const issues = paths(lbar(edit));
    assert.ok(issues.some((issue) => expected.test(issue)), `${expected} not in ${JSON.stringify(issues)}`);
  };
  const side = (page: Doc) => page.primitives[1];
  refused((page) => { delete side(page).items[0].layout; }, /^\/pages\/0\/primitives\/1\/items\/0\/layout /);
  refused((page) => { side(page).items[0].layout = "corner"; }, /^\/pages\/0\/primitives\/1\/items\/0\/anchor /);
  refused((page) => { page.primitives[3].turn.offset_ms = 8000; }, /^\/pages\/0\/primitives\/3\/turn\/offset_ms must be less than every_ms/);
  refused((page) => { page.primitives[3].turn.match = "tag"; }, /^\/pages\/0\/primitives\/3\/turn\/match is allowed only with on video/);
  refused((page) => { side(page).turn.every_ms = 999; }, /^\/pages\/0\/primitives\/1\/turn\/every_ms /);
  refused((page) => { side(page).turn.min_ms = 60001; }, /^\/pages\/0\/primitives\/1\/turn\/min_ms /);
  refused((page) => { side(page).transition.duration_ms = 2001; }, /^\/pages\/0\/primitives\/1\/transition\/duration_ms /);
  refused((page) => { side(page).transition.type = "crossfade"; }, /^\/pages\/0\/primitives\/1\/transition\/type /);
  refused((page) => { page.primitives.splice(0, 1); page.advance = { mode: "duration", after_ms: 8000 }; }, /\/turn\/on video needs exactly one video primitive on the page/);
  refused((page) => { side(page).items[0].id = "a"; }, /^\/pages\/0\/primitives\/1\/items\/0\/id must be unique within the page, across primitives and container items/);
  refused((page) => { page.primitives[3].items[1].id = "b_city"; }, /^\/pages\/0\/primitives\/3\/items\/1\/id must be unique/);
  refused((page) => { for (const item of side(page).items) item.when = { data: { key: "scores" } }; }, /^\/pages\/0\/primitives\/1\/items must hold at least one item without when/);
  refused((page) => { side(page).items = Array.from({ length: 9 }, (_, index) => textItem(`x${index}`)); }, /^\/pages\/0\/primitives\/1\/items /);
  refused((page) => { side(page).items[1].selector = { by: "ids", media_ids: ["med_photo"] }; }, /^\/pages\/0\/primitives\/1\/items\/1\/selector/);
  refused((page) => { side(page).items[0].tags = []; }, /^\/pages\/0\/primitives\/1\/items\/0\/tags /);
  refused((page) => { side(page).items[0].tags = ["two words"]; }, /^\/pages\/0\/primitives\/1\/items\/0\/tags\/0 /);
  refused((page) => { side(page).items[0].rect = { x: 0, y: 0, width: 1, height: 1 }; }, /^\/pages\/0\/primitives\/1\/items\/0\/rect /);
  refused((page) => { side(page).content_fit = "fill"; }, /^\/pages\/0\/primitives\/1\/content_fit /);
  refused((page) => { side(page).motion = { type: "spin", direction: "cw", speed: "slow" }; }, /^\/pages\/0\/primitives\/1\/motion /);
  refused((page) => { delete side(page).turn; }, /^\/pages\/0\/primitives\/1\/turn /);
  refused((page) => {
    for (let index = 0; index < 4; index++) page.primitives.push({ ...structuredClone(page.primitives[3]), id: `extra${index}`, items: [textItem(`extra${index}_item`)] });
  }, /^\/pages\/0\/primitives\/6 a page holds at most 4 containers/);
  refused((page) => {
    // Six entries: a video, two cards and three containers of 7 items each, which count 27.
    page.primitives = [page.primitives[0], page.primitives[2], ...[1, 2, 3].map((n) => ({ ...structuredClone(page.primitives[3]), id: `k${n}`, items: Array.from({ length: 7 }, (_, index) => textItem(`k${n}_${index}`)) }))];
    page.primitives.push({ ...structuredClone(page.primitives[1]), id: "c2" });
  }, /^\/pages\/0\/primitives must contain at most 24 primitives, counting each container and each of its items/);
  // A container holds cards and images only: the wire check names the item before the schema runs.
  const nested = lbar((page) => { page.primitives[1].items[0] = { id: "inner", primitive: "video", selector: { by: "id", media_id: "med_one" } }; });
  assert.throws(() => assertWirePages(nested.pages), /primitives\[1\]\.items\[0\]\.primitive must be card or image: a container holds cards and images/);
  assert.throws(() => assertWirePages(lbar((page) => { page.primitives[1].selector = { by: "id", media_id: "med_one" }; }).pages), /container does not take a selector/);
});

test("playlist show --editable round-trips a stored container, and page edits send it back as authoring", () => {
  const stored = {
    id: "pl_LBAR", revision: 4, name: "L-bar",
    pages: [{
      id: "lbar", canvas: { width: 1920, height: 1080, background: "#000000FF" }, transition: { type: "crossfade", duration_ms: 400 }, advance: { mode: "media_end", max_ms: 30000 },
      primitives: [
        { id: "a", primitive: "video", selector: { by: "id", media_id: "med_one", one_at_a_time: false }, resolved_media: [{ media_id: "med_one" }], rect: { x: 0, y: 0, width: 1440, height: 1080 }, layer: 0, content_fit: "cover", controller: false, muted: true, loop: false },
        {
          id: "b", primitive: "container", rect: { x: 1440, y: 0, width: 480, height: 1080 }, layer: 1,
          turn: { on: "video", every_ms: 12000, offset_ms: 0, min_ms: 0, match: "tag", no_match: "clock" },
          transition: { type: "cut", duration_ms: 0 },
          items: [
            { id: "wx", primitive: "card", card: "weather", major: 1, params: { units: "metric" }, layout: "full", feed: "feed:weather:49.28,-123.12", tags: ["city"] },
            { id: "room", primitive: "card", card: "crd_room", type: "room", major: 2, params: { title: "Room" }, data: "crd_room", layout: "full" },
            { id: "pic", primitive: "image", selector: { by: "id", media_id: "med_pic", one_at_a_time: false }, resolved_media: [{ media_id: "med_pic" }], content_fit: "contain", when: { data: { key: "{page.video}", path: "/index", equals: 0 } } },
          ],
        },
      ],
    }],
  };
  const document = editablePlaylist(structuredClone(stored));
  const container = document.pages[0].primitives[1];
  assert.deepEqual(container, {
    id: "b", primitive: "container", rect: { x: 1440, y: 0, width: 480, height: 1080 }, layer: 1,
    turn: { on: "video", every_ms: 12000, offset_ms: 0, min_ms: 0, match: "tag", no_match: "clock" },
    transition: { type: "cut", duration_ms: 0 },
    items: [
      { id: "wx", primitive: "card", card: "weather", major: 1, params: { units: "metric" }, layout: "full", tags: ["city"] },
      { id: "room", primitive: "card", card: "crd_room", layout: "full" },
      { id: "pic", primitive: "image", selector: { by: "id", media_id: "med_pic" }, content_fit: "contain", when: { data: { key: "{page.video}", path: "/index", equals: 0 } } },
    ],
  });
  assert.deepEqual(paths(document), []);
  // A page edit keeps the stored container and drops from its items only what an authored page refuses.
  const page = authoringPage(structuredClone(stored.pages[0]) as Doc);
  const sent = (page.primitives as Doc[])[1]!;
  assert.deepEqual(sent.items, [
    { id: "wx", primitive: "card", card: "weather", major: 1, params: { units: "metric" }, layout: "full", tags: ["city"] },
    { id: "room", primitive: "card", card: "crd_room", data: "crd_room", layout: "full" },
    { id: "pic", primitive: "image", selector: { by: "id", media_id: "med_pic", one_at_a_time: false }, content_fit: "contain", when: { data: { key: "{page.video}", path: "/index", equals: 0 } } },
  ]);
  assert.deepEqual({ ...sent, items: undefined }, { ...container, items: undefined });
  assert.equal(stored.pages[0]!.primitives[1]!.items![0]!.feed, "feed:weather:49.28,-123.12", "the stored page is not changed");
});

test("card checks read a container's card items, and {page.video} binds a card's data", async () => {
  const details: CardDetails = {
    id: "text", major: 1, version: "1.0.0", tier: "core", layouts: ["full", "free"], feed: "", example: {},
    params_schema: { type: "object", additionalProperties: false, properties: { title: { type: "string", maxLength: 10 } }, required: ["title"] },
    data_schema: { type: "object", properties: { title: { type: "string", "x-dynamic": true } } },
  };
  const transport = new FakeTransport().on("GET", "/api/card-types/text", () => ({ status: 200, headers: {}, body: details }));
  const client = new ApiClient({ transport });
  // Card c binds {page.video}, so its dynamic title comes from the record and is left out of params.
  await validatePlaylistCards(client, lbar() as { pages: any[] });
  await assert.rejects(() => validatePlaylistCards(client, lbar((page) => { page.primitives[3].items[1].params = { title: "x".repeat(11) }; }) as { pages: any[] }),
    /pages\[0\]\.primitives\[3\]\.items\[1\]\.params/);
  await assert.rejects(() => validatePlaylistCards(client, lbar((page) => { page.primitives[3].items[0].layout = "corner"; page.primitives[3].items[0].anchor = "top-left"; }) as { pages: any[] }),
    /pages\[0\]\.primitives\[3\]\.items\[0\]\.layout: card text \(core tier\) takes full, free, not corner/);
});

test("a template's container items read fields as primitives do, and a locked container covers them", () => {
  const template = (edit: (page: Doc) => void = () => undefined) => {
    const document = lbar((page) => {
      page.primitives[3].items[0].params = { title: "{field.headline}" };
      page.primitives[1].items[1].selector = { by: "id", media_id: "{field.photo}" };
      edit(page);
    });
    document.pages.pop();
    return { ...document, fields: [{ name: "headline", label: "Headline", type: "text", required: true }, { name: "photo", label: "Photo", type: "media", required: true }] };
  };
  assert.deepEqual(paths(template()), []);
  assert.ok(paths(template((page) => { page.primitives[3].locked = true; })).some((issue) => issue.startsWith("/pages/0/primitives/3/locked a locked primitive cannot read a field")));
  assert.ok(paths(template((page) => { page.primitives[3].items[1].tags = ["{field.headline}"]; })).length > 0);
  assert.ok(paths(template((page) => { page.primitives[1].items[1].selector.media_id = "{field.headline}"; })).some((issue) => issue.includes("/items/1/selector/media_id") && issue.includes("takes a media field")));
});

test("a playlist bundle carries no container, and its page conditions may read {page.video}", () => {
  const media = new Map([["med_one", "video" as const]]);
  const bundle = (primitives: unknown[], visibility?: unknown) => ({
    name: "Bundle",
    pages: [
      { id: "p", canvas: { width: 1920, height: 1080, background: "#000000FF" }, transition: { type: "crossfade", duration_ms: 200 }, advance: { mode: "media_end" }, primitives },
      { id: "q", canvas: { width: 1920, height: 1080, background: "#000000FF" }, transition: { type: "crossfade", duration_ms: 200 }, advance: { mode: "media_end" }, ...(visibility ? { visibility } : {}), primitives },
    ],
  });
  const video = { id: "a", primitive: "video", selector: { by: "id", media_id: "med_one" }, rect: { x: 0, y: 0, width: 1920, height: 1080 }, layer: 0, content_fit: "cover", muted: true, loop: false };
  validatePlaylistWrite(bundle([video], { enabled: true, data: { key: "{page.video}", path: "/lap", equals: 1 } }), media);
  assert.throws(() => validatePlaylistWrite(bundle([video, { ...lbar().pages[0].primitives[3] }]), media), /Playlist bundles do not support container primitives/);
});

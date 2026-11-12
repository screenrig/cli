import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { makeProblem } from "./problems.js";
import { CliError } from "./problems.js";
import { mapLimit, runProjectExport, stripSecrets, type ExportApi } from "./project-export.js";

const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const IMAGE = Buffer.from("not really a jpeg, but bytes all the same".repeat(50));
const NOW = new Date("2026-10-29T12:00:00Z");
const CARD = { id: "crd_1", type: "menu", major: 1, params: { title: "Lunch" }, revision: 3 };
const CARD_DATA = {
  key: CARD.id, document: { sections: [{ name: "Lunch", items: [{ name: "Soup", description: "Crème fraîche", price: 12.5 }] }] },
  bytes: 122, sha256: "a".repeat(64), revision: 5, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-10-28T12:00:00Z",
  expires_at: "2026-11-01T00:00:00Z", expired: false,
};
const STANDALONE_DATA = {
  key: "menu:standalone", document: { nested: { enabled: true, rows: [1, "Résumé", null] } },
  bytes: 60, sha256: "b".repeat(64), revision: 7, created_at: "2026-09-01T00:00:00Z", updated_at: "2026-10-28T12:00:00Z",
};

interface Calls { gets: string[]; files: string[]; appends: Array<{ path: string; offset: number }> }

function fakeApi(calls: Calls, overrides: Partial<Record<string, unknown>> = {}): ExportApi {
  const routes: Record<string, unknown> = {
    "/api/project": { id: "prj_1", name: "Venetian", created_at: "2026-09-01T00:00:00Z" },
    "/api/screens": [{ id: "scr_1", label: "Lobby", tags: ["Lobby", "Wall"] }, { id: "scr_2", label: "Bar", tags: ["Wall"] }],
    "/api/screen-folders": { items: [{ id: "sfd_1", name: "Tower" }] },
    "/api/media-folders": { items: [] },
    "/api/playlists": [{ id: "pl_1", name: "Loop" }],
    "/api/playlists/pl_1": { id: "pl_1", pages: [] },
    "/api/playlists/pl_1/revisions": [{ revision: 2 }, { revision: 1 }],
    "/api/playlists/pl_1/revisions/1": { revision: 1 },
    "/api/playlists/pl_1/revisions/2": { revision: 2 },
    "/api/campaigns": { items: [{ id: "cmp_1" }] },
    "/api/advertising/direct-campaigns": { items: [] },
    "/api/cards": [CARD],
    "/api/cards/crd_1": { ...CARD, data: CARD_DATA },
    "/api/card-data": [CARD_DATA, STANDALONE_DATA].map(({ document: _document, ...summary }) => summary),
    "/api/card-data/crd_1": CARD_DATA,
    "/api/card-data/menu%3Astandalone": STANDALONE_DATA,
    "/api/sources": [{ id: "src_1", config: { url: "https://x.invalid/feed" }, secrets: { token: "sealed" }, url: "https://hook.invalid/path/secret-token" }],
    "/api/notifications": { items: [{ id: "ntf_1", url: "https://hooks.invalid/services/T0/B0/XXXX", secret: "whsec_1", recipients: ["owner"] }] },
    "/api/alert-mutes": { items: [] },
    "/api/webhooks": { items: [{ id: "whk_1", url: "https://example.invalid/receive?key=abc" }] },
    "/api/applications": [],
    "/api/triggers": { items: [] },
    "/api/report-subscriptions": { items: [{ id: "rsub_1" }] },
    "/api/media": [{ id: "med_1", filename: "a.jpg", content_type: "image/jpeg", primitive: "image", bytes: IMAGE.length, sha256: sha(IMAGE), tags: [] }],
    ...overrides,
  };
  const events = [{ id: "e1", type: "screen.online" }, { id: "e2", type: "screen.offline" }, { id: "e3", type: "note.created" }];
  return {
    async get(pathName, query) {
      calls.gets.push(pathName);
      if (pathName === "/api/events") {
        const start = Number(query?.after ?? query?.before ?? 0);
        const items = events.slice(start, start + 2);
        return { items, next_cursor: start + 2 < events.length ? String(start + 2) : null };
      }
      if (pathName.endsWith("-schedule")) return { entries: [] };
      if (!(pathName in routes)) throw new CliError(makeProblem("not_found", "Not found", 404, `no ${pathName}`));
      const value = routes[pathName];
      if (value instanceof Error) throw value;
      return value;
    },
    async list(pathName, query) {
      calls.gets.push(`${pathName}${query?.state ? `?state=${query.state}` : ""}`);
      if (query?.state === "archived") return [];
      const value = routes[pathName];
      if (value instanceof Error) throw value;
      return (value as unknown[]) ?? [];
    },
    async file(pathName, query, target) {
      calls.files.push(`${pathName} ${query.from ?? query.day_from ?? query.state ?? ""}`);
      const plays = pathName === "/api/playback/plays";
      await writeFile(target, plays ? `play_id,screen_id\n${query.from?.slice(0, 7)},scr_1\n` : `col\nrow\n`);
    },
    async append(pathName, offset, target) {
      calls.appends.push({ path: pathName, offset });
      const { appendFile, writeFile: write } = await import("node:fs/promises");
      if (offset > 0) await appendFile(target, IMAGE.subarray(offset));
      else await write(target, IMAGE);
    },
  };
}

async function inTemp(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "screenrig-export-"));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("a project exports to open files with a manifest of hashes and no secrets", async () => {
  await inTemp(async (directory) => {
    const calls: Calls = { gets: [], files: [], appends: [] };
    const result = await runProjectExport(fakeApi(calls), { directory, media: true, now: NOW });
    assert.equal(result.failed, 0, JSON.stringify(result.sections.filter((section) => section.status !== "ok")));
    const manifest = JSON.parse(await readFile(path.join(directory, "export.json"), "utf8")) as { format: string; project_id: string; files: Array<{ path: string; sha256: string; bytes: number }> };
    assert.equal(manifest.format, "screenrig.export/v1");
    assert.equal(manifest.project_id, "prj_1");
    for (const name of ["project.json", "screens/screens.json", "screens/folders.json", "screens/schedules.json", "tags.json", "playlists/pl_1/playlist.json", "playlists/pl_1/revisions/1.json",
      "playlists/pl_1/revisions/2.json", "campaigns.json", "cards/cards.json", "sources.json", "notifications.json", "webhooks.json", "applications.json", "log/events.jsonl",
      "data/plays.csv", "data/uptime-daily.csv", "data/alerts.csv", "media/manifest.json", "media/files/med_1.jpg"]) {
      const entry = manifest.files.find((file) => file.path === name);
      assert.ok(entry, `${name} is listed`);
      const bytes = await readFile(path.join(directory, name));
      assert.equal(sha(bytes), entry.sha256, `${name} matches its recorded hash`);
    }
    const tags = JSON.parse(await readFile(path.join(directory, "tags.json"), "utf8")) as Array<{ tag: string; screen_ids: string[] }>;
    assert.deepEqual(tags.map((tag) => [tag.tag, tag.screen_ids.length]), [["Lobby", 1], ["Wall", 2]]);
    const events = (await readFile(path.join(directory, "log/events.jsonl"), "utf8")).trim().split("\n");
    assert.equal(events.length, 3, "every page of the event log is written");
    const everything = (await Promise.all((await listFiles(directory)).map((file) => readFile(file, "utf8").catch(() => "")))).join("\n");
    for (const secret of ["whsec_1", "secret-token", "XXXX", "sealed", "key=abc"]) assert.ok(!everything.includes(secret), `${secret} stays out of the export`);
    const notifications = JSON.parse(await readFile(path.join(directory, "notifications.json"), "utf8")) as Array<Record<string, unknown>>;
    assert.equal(notifications[0]?.url_origin, "https://hooks.invalid");
    assert.equal(notifications[0]?.url, undefined);
    const plays = (await readFile(path.join(directory, "data/plays.csv"), "utf8")).trim().split("\n");
    assert.equal(plays[0], "play_id,screen_id", "one header over every window of plays");
    assert.ok(plays.length > 2, "plays are read in windows of at most 31 days");
    assert.equal((await readdir(path.join(directory, "data"))).some((name) => name.includes(".part") || name.includes(".window")), false);
  });
});

test("card documents and their metadata survive exports with and without media", async () => {
  for (const media of [true, false]) {
    await inTemp(async (directory) => {
      const calls: Calls = { gets: [], files: [], appends: [] };
      const emptyCard = { ...CARD, id: "crd_empty" };
      const api = fakeApi(calls, {
        "/api/cards": [CARD, emptyCard],
        "/api/cards/crd_empty": { ...emptyCard, data: null },
      });
      const result = await runProjectExport(api, { directory, media, since: "2026-10-29", now: NOW });
      assert.deepEqual(result.sections.find((section) => section.name === "cards"), { name: "cards", status: "ok", files: 2 });
      const read = async (relative: string): Promise<unknown> => JSON.parse(await readFile(path.join(directory, relative), "utf8")) as unknown;
      assert.deepEqual(await read("cards/cards.json"), [{ ...CARD, data: CARD_DATA }, { ...emptyCard, data: null }]);
      assert.deepEqual(await read("cards/card-data.json"), [CARD_DATA, STANDALONE_DATA]);
      for (const relative of ["cards/cards.json", "cards/card-data.json"]) {
        const file = result.files.find((entry) => entry.path === relative);
        assert.ok(file, `${relative} is in the manifest`);
        const bytes = await readFile(path.join(directory, relative));
        assert.equal(file.bytes, bytes.length);
        assert.equal(file.sha256, sha(bytes));
      }
    });
  }
});

test("published application files are reported as omitted on exports and refreshes, including without media", async () => {
  await inTemp(async (directory) => {
    const application = { id: "app_1", latest_ready_release: "rel_2", revision: 3 };
    const playlist = (release: string) => ({ id: "pl_1", pages: [{ primitives: [{ primitive: "application", release_id: release }] }] });
    const firstRevision = { revision: { revision: 1 }, playlist: playlist("rel_1") };
    const latestRevision = { revision: { revision: 2 }, playlist: playlist("rel_2") };
    for (const media of [true, false, true]) {
      const result = await runProjectExport(fakeApi({ gets: [], files: [], appends: [] }, {
        "/api/applications": [application],
        "/api/playlists/pl_1": playlist("rel_2"),
        "/api/playlists/pl_1/revisions/1": firstRevision,
        "/api/playlists/pl_1/revisions/2": latestRevision,
      }), { directory, media, now: NOW });
      assert.equal(result.failed, 1, "missing application content makes the export incomplete");
      const omitted = result.sections.find((section) => section.name === "application files");
      assert.equal(omitted?.status, "failed");
      assert.equal(omitted?.code, "application_content_omitted");
      assert.match(omitted?.detail ?? "", /original application archives/i);
      const read = async (relative: string): Promise<unknown> => JSON.parse(await readFile(path.join(directory, relative), "utf8")) as unknown;
      assert.deepEqual(await read("applications.json"), [application], "metadata remains recoverable");
      assert.deepEqual(await read("triggers.json"), [], "triggers still export");
      assert.deepEqual(await read("playlists/pl_1/revisions/1.json"), firstRevision, "the old release pin is preserved");
      assert.deepEqual(await read("playlists/pl_1/revisions/2.json"), latestRevision, "the current release pin is preserved");
      const manifest = await read("export.json") as { sections: unknown };
      assert.deepEqual(manifest.sections, result.sections, "the on-disk copy records the omission too");
      const entry = result.files.find((file) => file.path === "applications.json");
      assert.ok(entry);
      assert.equal(entry.sha256, sha(await readFile(path.join(directory, entry.path))));
    }
  });
});

const kvEntry = (key: string, value: Buffer, contentType = "application/octet-stream", revision = 1) => ({
  application_id: "app_1", key, value_base64: value.toString("base64"), content_type: contentType,
  bytes: value.length, sha256: sha(value), revision,
});

test("application K/V exports recover exact values and metadata in every export mode", async () => {
  const values = [
    kvEntry("menu/title", Buffer.from("Crème brûlée — 日本語"), "text/plain; charset=utf-8", 3),
    kvEntry("settings", Buffer.from('{"enabled":true,"secret":"ordinary application state","rows":[1,null]}'), "application/json", 2),
    kvEntry("binary", Buffer.from([0, 255, 128, 13, 10, 0])),
    kvEntry("empty", Buffer.alloc(0)),
  ];
  for (const options of [{ media: true }, { media: false }, { media: true, since: "2026-10-29" }]) {
    await inTemp(async (directory) => {
      const calls: Calls = { gets: [], files: [], appends: [] };
      const api = fakeApi(calls, {
        "/api/applications": [{ id: "app_1" }, { id: "app_empty" }],
        "/api/applications/app_1/kv": values.map(({ value_base64: _value, ...metadata }) => metadata),
        ...Object.fromEntries(values.map((entry) => [`/api/applications/app_1/kv/${encodeURIComponent(entry.key)}`, entry])),
      });
      const result = await runProjectExport(api, { directory, ...options, now: NOW });
      assert.deepEqual(result.sections.find((section) => section.name === "applications"), { name: "applications", status: "ok", files: 4 });
      assert.equal(result.failed, 1, "the separate application-release omission remains explicit");
      const exported = JSON.parse(await readFile(path.join(directory, "applications/app_1/kv.json"), "utf8")) as typeof values;
      assert.deepEqual(exported, values);
      for (const entry of exported) {
        const bytes = Buffer.from(entry.value_base64, "base64");
        assert.equal(bytes.length, entry.bytes);
        assert.equal(sha(bytes), entry.sha256);
      }
      assert.deepEqual(JSON.parse(await readFile(path.join(directory, "applications/app_empty/kv.json"), "utf8")), []);
      assert.ok(calls.gets.includes("/api/applications/app_1/kv/menu%2Ftitle"), "keys stay in JSON, not filesystem paths");
      for (const relative of ["applications/app_1/kv.json", "applications/app_empty/kv.json"]) {
        const file = result.files.find((entry) => entry.path === relative);
        assert.ok(file, `${relative} is in the manifest`);
        const bytes = await readFile(path.join(directory, relative));
        assert.equal(file.bytes, bytes.length);
        assert.equal(file.sha256, sha(bytes));
      }
    });
  }
});

test("refresh replaces changed and deleted K/V entries, preserving the last snapshot on a read failure", async () => {
  await inTemp(async (directory) => {
    const read = () => readFile(path.join(directory, "applications/app_1/kv.json"), "utf8");
    const initial = [kvEntry("menu/title", Buffer.from("Old title")), kvEntry("binary", Buffer.from([0, 255]))];
    const updated = [kvEntry("menu/title", Buffer.from("New title"), "text/plain", 2), kvEntry("new-item", Buffer.from("Added"))];
    const apiFor = (values: typeof initial, failure?: Error): ExportApi => fakeApi({ gets: [], files: [], appends: [] }, {
      "/api/applications": [{ id: "app_1" }],
      "/api/applications/app_1/kv": values.map(({ value_base64: _value, ...metadata }) => metadata),
      ...Object.fromEntries(values.map((entry) => [`/api/applications/app_1/kv/${encodeURIComponent(entry.key)}`, failure ?? entry])),
    });
    await runProjectExport(apiFor(initial), { directory, media: false, now: NOW });
    assert.deepEqual(JSON.parse(await read()), initial);
    await runProjectExport(apiFor(updated), { directory, media: false, now: NOW });
    assert.deepEqual(JSON.parse(await read()), updated, "deleted keys disappear instead of lingering in the backup");
    const snapshot = await read();
    const result = await runProjectExport(apiFor(updated, new CliError(makeProblem("not_found", "Not found", 404, "Entry disappeared"))), { directory, media: false, now: NOW });
    assert.equal(result.sections.find((section) => section.name === "applications")?.status, "failed");
    assert.equal(await read(), snapshot, "a failed refresh leaves the previous complete per-application file");
    assert.equal(result.files.some((file) => file.path === "applications/app_1/kv.json"), false, "the manifest does not certify a stale snapshot");
  });
});

test("unreadable application K/V lists or values fail the section instead of silently skipping state", async () => {
  const entry = kvEntry("menu/title", Buffer.from("Lunch"));
  for (const route of ["/api/applications/app_1/kv", "/api/applications/app_1/kv/menu%2Ftitle"]) {
    for (const [code, status] of [["forbidden", 403], ["not_found", 404], ["dependency_unavailable", 503]] as const) {
      await inTemp(async (directory) => {
        const result = await runProjectExport(fakeApi({ gets: [], files: [], appends: [] }, {
          "/api/applications": [{ id: "app_1" }],
          "/api/applications/app_1/kv": [entry],
          "/api/applications/app_1/kv/menu%2Ftitle": entry,
          [route]: new CliError(makeProblem(code, "Read failed", status, "Application state could not be read")),
        }), { directory, media: false, now: NOW });
        const applications = result.sections.find((section) => section.name === "applications");
        assert.equal(applications?.status, "failed", `${route}: ${status} makes the copy incomplete`);
        assert.equal(applications?.code, code);
        assert.equal(result.failed, 2, "K/V failure is distinct from the existing release-content omission");
        assert.equal(result.files.some((file) => file.path === "applications/app_1/kv.json"), false);
        assert.equal(result.sections.find((section) => section.name === "report subscriptions")?.status, "ok");
      });
    }
  }
});

test("an empty application catalog does not hide release files referenced only by a playlist revision", async () => {
  await inTemp(async (directory) => {
    const api = fakeApi({ gets: [], files: [], appends: [] });
    let result = await runProjectExport(api, { directory, media: false, now: NOW });
    assert.equal(result.failed, 0, "a project without applications needs no application files");
    const get = api.get.bind(api);
    api.get = async (route, query) => route === "/api/playlists/pl_1/revisions/1"
      ? { revision: { revision: 1 }, playlist: { pages: [{ primitives: [{ primitive: "application", release_id: "rel_OLD" }] }] } }
      : get(route, query);
    result = await runProjectExport(api, { directory, media: false, now: NOW });
    assert.equal(result.failed, 1);
    assert.equal(result.sections.find((section) => section.name === "application files")?.status, "failed");
  });
});

test("a listed card or document that cannot be read fails the section instead of skipping missing content", async () => {
  for (const route of ["/api/cards/crd_1", "/api/card-data/menu%3Astandalone"]) {
    for (const [code, status] of [["forbidden", 403], ["not_found", 404], ["dependency_unavailable", 503]] as const) {
      await inTemp(async (directory) => {
        const result = await runProjectExport(fakeApi({ gets: [], files: [], appends: [] }, {
          [route]: new CliError(makeProblem(code, "Read failed", status, "Document could not be read")),
        }), { directory, media: false, now: NOW });
        const cards = result.sections.find((section) => section.name === "cards");
        assert.equal(cards?.status, "failed", `${route}: ${status} must make the copy incomplete`);
        assert.equal(cards?.code, code);
        assert.equal(result.failed, 1);
        assert.equal(result.files.some((file) => file.path.startsWith("cards/")), false, "no partial card snapshot is published");
        assert.equal(result.sections.find((section) => section.name === "sources")?.status, "ok", "other sections still export");
      });
    }
  }
});

test("the exit export carries the audit log oldest first and the chain head it ends at", async () => {
  await inTemp(async (directory) => {
    const head = { scope: "prj_1", seq: 3, hash: "a".repeat(64), floor_seq: 0, floor_hash: "b".repeat(64), unsealed: 0 };
    const newestFirst = [{ id: "aud_3", at: "2026-10-03T00:00:00Z", changes: [] }, { id: "aud_2", at: "2026-10-02T00:00:00Z", changes: [] }, { id: "aud_1", at: "2026-10-01T00:00:00Z", changes: [] }];
    const api = fakeApi({ gets: [], files: [], appends: [] }, { "/api/audit/head": head });
    const base = api.get.bind(api);
    api.get = async (pathName, query) => {
      if (pathName !== "/api/audit") return base(pathName, query);
      return query?.cursor ? { items: newestFirst.slice(2), next_cursor: null } : { items: newestFirst.slice(0, 2), next_cursor: "au1_page2" };
    };
    const result = await runProjectExport(api, { directory, media: false, now: NOW });
    assert.equal(result.failed, 0, JSON.stringify(result.sections.filter((section) => section.status !== "ok")));
    const lines = (await readFile(path.join(directory, "log/audit.jsonl"), "utf8")).trim().split("\n").map((line) => (JSON.parse(line) as { id: string }).id);
    assert.deepEqual(lines, ["aud_1", "aud_2", "aud_3"]);
    assert.deepEqual(JSON.parse(await readFile(path.join(directory, "log/audit-head.json"), "utf8")), head);
    const manifest = JSON.parse(await readFile(path.join(directory, "export.json"), "utf8")) as { files: Array<{ path: string }> };
    assert.ok(manifest.files.some((file) => file.path === "log/audit.jsonl") && manifest.files.some((file) => file.path === "log/audit-head.json"));
  });
});

async function listFiles(directory: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out;
}

test("--since bounds the event log to the days from it, oldest first", async () => {
  await inTemp(async (directory) => {
    const calls: Calls = { gets: [], files: [], appends: [] };
    const api = fakeApi(calls);
    const events = [
      { id: "e3", at: "2026-10-28T12:00:00Z" }, { id: "e2", at: "2026-10-27T12:00:00Z" }, { id: "e1", at: "2026-10-01T12:00:00Z" },
    ];
    const wrapped: ExportApi = {
      ...api,
      async get(pathName, query) {
        if (pathName !== "/api/events") return api.get(pathName, query);
        assert.equal(query?.order, "desc");
        return { items: events, next_cursor: null };
      },
    };
    await runProjectExport(wrapped, { directory, media: false, since: "2026-10-27", now: NOW });
    const lines = (await readFile(path.join(directory, "log/events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { id: string });
    assert.deepEqual(lines.map((line) => line.id), ["e2", "e3"]);
  });
});

test("a rerun keeps complete media, continues a partial download and refreshes the rest", async () => {
  await inTemp(async (directory) => {
    const first: Calls = { gets: [], files: [], appends: [] };
    await runProjectExport(fakeApi(first), { directory, media: true, now: NOW });
    assert.equal(first.appends.length, 1);
    const again: Calls = { gets: [], files: [], appends: [] };
    const second = await runProjectExport(fakeApi(again), { directory, media: true, now: NOW });
    assert.equal(again.appends.length, 0, "a complete file is not downloaded again");
    assert.deepEqual(second.media, { listed: 1, downloaded: 0, kept: 1, failed: 0 });

    // An interrupted download left half the bytes in the .part file.
    const target = path.join(directory, "media/files/med_1.jpg");
    await rm(target);
    await writeFile(`${target}.part`, IMAGE.subarray(0, 700));
    const resumed: Calls = { gets: [], files: [], appends: [] };
    const third = await runProjectExport(fakeApi(resumed), { directory, media: true, now: NOW });
    assert.deepEqual(resumed.appends, [{ path: "/api/media/med_1/content", offset: 700 }], "the download continues from the bytes it has");
    assert.equal(third.media.downloaded, 1);
    assert.equal(sha(await readFile(target)), sha(IMAGE));

    // A damaged copy does not match its record: it is fetched again.
    await writeFile(target, Buffer.from("damaged"));
    const repaired: Calls = { gets: [], files: [], appends: [] };
    await runProjectExport(fakeApi(repaired), { directory, media: true, now: NOW });
    assert.equal(repaired.appends.length, 1);
    assert.equal(sha(await readFile(target)), sha(IMAGE));
  });
});

test("a section the credential cannot read is skipped, and a failure is reported without stopping the copy", async () => {
  await inTemp(async (directory) => {
    const forbidden = new CliError(makeProblem("forbidden", "Forbidden", 403, "needs the project capability"));
    const broken = new CliError(makeProblem("dependency_unavailable", "Unavailable", 503, "briefly unavailable"));
    const result = await runProjectExport(fakeApi({ gets: [], files: [], appends: [] }, { "/api/webhooks": forbidden, "/api/sources": broken }), { directory, media: false, now: NOW });
    const statuses = Object.fromEntries(result.sections.map((section) => [section.name, section.status]));
    assert.equal(statuses.webhooks, "skipped");
    assert.equal(statuses.sources, "failed");
    assert.equal(statuses.playlists, "ok", "the rest of the copy is still written");
    assert.equal(result.failed, 1);
    assert.equal(await stat(path.join(directory, "media/files")).catch(() => null), null, "--no-media writes no media files");
    const manifest = JSON.parse(await readFile(path.join(directory, "media/manifest.json"), "utf8")) as { files: Array<{ id: string; path: string | null; sha256: string }> };
    assert.equal(manifest.files[0]?.path, null);
    assert.equal(manifest.files[0]?.sha256, sha(IMAGE), "the manifest still carries the hash");
  });
});

test("stripSecrets keeps what a reader needs and drops what could be a credential", () => {
  assert.deepEqual(stripSecrets({ id: "x", url: "https://a.invalid:8443/p?k=1", secret: "s", secrets: { b: "1", a: "2" } }), { id: "x", url_origin: "https://a.invalid:8443", secret_names: ["a", "b"] });
});

test("mapLimit runs a few at a time and keeps the order of the results", async () => {
  let running = 0;
  let peak = 0;
  const out = await mapLimit([5, 1, 4, 2, 3, 6], 2, async (value) => {
    running += 1;
    peak = Math.max(peak, running);
    await new Promise((resolve) => setTimeout(resolve, value));
    running -= 1;
    return value * 10;
  });
  assert.deepEqual(out, [50, 10, 40, 20, 30, 60]);
  assert.equal(peak, 2);
  await assert.rejects(mapLimit([1, 2, 3], 2, async (value) => { if (value === 2) throw new Error("boom"); return value; }), /boom/);
});

test("an audit log the project's plan does not include is skipped, not a failed copy", async () => {
  await inTemp(async (directory) => {
    const notInPlan = new CliError(makeProblem("feature_not_in_plan", "This feature is not in the project's plan", 402, "The audit log is part of Premium. This account is on Standard."));
    const result = await runProjectExport(fakeApi({ gets: [], files: [], appends: [] }, { "/api/audit/head": notInPlan }), { directory, media: false, now: NOW });
    const statuses = Object.fromEntries(result.sections.map((section) => [section.name, section.status]));
    assert.equal(statuses["audit log"], "skipped");
    assert.equal(result.failed, 0);
  });
});

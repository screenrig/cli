import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { makeProblem } from "./problems.js";
import { CliError } from "./problems.js";
import { runProjectExport, stripSecrets, type ExportApi } from "./project-export.js";

const sha = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const IMAGE = Buffer.from("not really a jpeg, but bytes all the same".repeat(50));
const NOW = new Date("2026-10-29T12:00:00Z");

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
    "/api/cards": [{ id: "crd_1", data: { a: 1 } }],
    "/api/card-data": [{ key: "menu" }],
    "/api/sources": [{ id: "src_1", config: { url: "https://x.invalid/feed" }, secrets: { token: "sealed" }, url: "https://hook.invalid/path/secret-token" }],
    "/api/notifications": { items: [{ id: "ntf_1", url: "https://hooks.invalid/services/T0/B0/XXXX", secret: "whsec_1", recipients: ["owner"] }] },
    "/api/alert-mutes": { items: [] },
    "/api/webhooks": { items: [{ id: "whk_1", url: "https://example.invalid/receive?key=abc" }] },
    "/api/applications": [{ id: "app_1" }],
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
        const start = query?.after ? Number(query.after) : 0;
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

async function listFiles(directory: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else out.push(full);
  }
  return out;
}

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

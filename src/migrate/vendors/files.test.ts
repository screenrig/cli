import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { testTemp } from "../../test-temp.js";
import { openLocalFiles } from "../local-files.js";
import { zipBytes, type ZipFixtureEntry } from "../zip-fixture.test.js";
import type { SourceCatalog } from "../types.js";
import { files } from "./files.js";

const FIXTURES = fileURLToPath(new URL("../../../fixtures/migrate/files/", import.meta.url));
const SIGNAGE = path.join(FIXTURES, "signage");
const FOLDERS = path.join(FIXTURES, "folders");

async function scan(source: string): Promise<SourceCatalog> {
  const session = await files.open({ credentials: {}, http: { client: () => { throw new Error("files reads no vendor"); } }, files: await openLocalFiles(source), now: () => new Date(0) });
  return session.scan();
}

async function tree(root: string, prefix = ""): Promise<ZipFixtureEntry[]> {
  const entries: ZipFixtureEntry[] = [];
  for (const item of (await readdir(path.join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = prefix === "" ? item.name : `${prefix}/${item.name}`;
    if (item.isDirectory()) entries.push(...await tree(root, relative));
    else entries.push({ name: relative, data: await readFile(path.join(root, relative)) });
  }
  return entries;
}

test("a folder with playlists.csv and screens.csv becomes media, playlists, groups and screens", async () => {
  const catalog = await scan(SIGNAGE);
  assert.equal(catalog.account, "files");
  assert.equal(catalog.label, "signage");
  assert.deepEqual(catalog.media.map((item) => [item.id, item.kind, item.filename, item.name, item.original]), [
    ["audio/theme.mp3", "audio", "theme.mp3", "theme", true],
    ["images/menu.png", "image", "menu.png", "menu", true],
    ["images/welcome.png", "image", "welcome.png", "welcome", true],
    ["video/intro.mp4", "video", "intro.mp4", "intro", true],
  ]);
  assert.deepEqual(catalog.not_imported.map((entry) => [entry.kind, entry.source_id, entry.reason]), [
    ["file", "docs/readme.txt", "It is not an image, video or audio file."],
    ["item", "playlists.csv row 7", "No such media file was found in --files."],
  ]);
  assert.equal(catalog.not_imported[1]!.name, "missing.png");
  assert.match(catalog.not_imported[1]!.next ?? "", /rerun migrate scan/);
  assert.deepEqual(catalog.playlists, [
    { id: "Lobby", name: "Lobby", items: [{ media_id: "images/welcome.png", duration_s: 12 }, { media_id: "video/intro.mp4" }, { media_id: "images/menu.png", duration_s: 5 }, { media_id: "audio/theme.mp3" }], notes: [] },
    { id: "Cafe", name: "Cafe", items: [{ media_id: "images/menu.png" }], notes: [] },
  ]);
  assert.deepEqual(catalog.groups, [{ id: "Lobby", name: "Lobby" }, { id: "Ground floor", name: "Ground floor" }]);
  assert.deepEqual(catalog.screens, [
    { id: "Front desk", name: "Front desk", group_ids: ["Lobby", "Ground floor"], content: { playlist_id: "Lobby" }, timezone: "America/Toronto", notes: [] },
    { id: "Cafe wall", name: "Cafe wall", group_ids: ["Ground floor"], content: { playlist_id: "Cafe" }, notes: [] },
    { id: "Back office, east", name: "Back office, east", group_ids: [], notes: [] },
  ]);
  assert.deepEqual(catalog.schedules, []);
  assert.deepEqual(catalog.layouts, []);
});

test("without playlists.csv each folder that holds media is a playlist in natural order, root files named after the folder", async () => {
  const catalog = await scan(FOLDERS);
  assert.deepEqual(catalog.playlists.map((playlist) => [playlist.id, playlist.name, playlist.items.map((item) => (item as { media_id: string }).media_id)]), [
    ["(root)", "folders", ["a.png"]],
    ["lobby", "lobby", ["lobby/1.png", "lobby/2.png", "lobby/10.png", "lobby/clip.mp4"]],
  ]);
  assert.deepEqual(catalog.screens, []);
});

test("the same tree in a zip scans the same", async () => {
  const dir = await testTemp("files-zip-");
  try {
    const archive = path.join(dir, "signage.zip");
    await writeFile(archive, zipBytes([...(await tree(SIGNAGE)), { name: "__MACOSX/._welcome.png", data: "fork" }, { name: ".DS_Store", data: "x" }]));
    const fromZip = await scan(archive);
    const fromFolder = await scan(SIGNAGE);
    assert.deepEqual({ ...fromZip, label: "" }, { ...fromFolder, label: "" });
    assert.equal(fromZip.label, "signage");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("encrypted and unreadable zip entries are listed, and odd entry names stay strings", async () => {
  const dir = await testTemp("files-zip-odd-");
  try {
    const png = await readFile(path.join(SIGNAGE, "images", "welcome.png"));
    const archive = path.join(dir, "odd.zip");
    await writeFile(archive, zipBytes([
      { name: "ok.png", data: png },
      { name: "secret.png", data: "ciphertext", encrypted: true },
      { name: "odd.mp4", data: "bytes", method: 99 },
      { name: "../escape.png", data: png },
    ]));
    const catalog = await scan(archive);
    assert.deepEqual(catalog.media.map((item) => item.id).sort(), ["../escape.png", "ok.png"]);
    assert.deepEqual(catalog.not_imported.map((entry) => [entry.source_id, entry.reason]), [
      ["odd.mp4", "It uses zip compression method 99, which this CLI cannot read."],
      ["secret.png", "It is encrypted in the zip."],
    ]);
    const session = await files.open({ credentials: {}, http: { client: () => { throw new Error("none"); } }, files: await openLocalFiles(archive), now: () => new Date(0) });
    const escape = catalog.media.find((item) => item.id === "../escape.png")!;
    const out = path.join(dir, "staged.png");
    assert.deepEqual(await session.fetchMedia(escape, out), { bytes: png.length });
    assert.deepEqual(await readFile(out), png);
    await assert.rejects(stat(path.resolve(dir, "..", "escape.png")), { code: "ENOENT" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("fetchMedia copies a folder file to the destination and refuses one that has gone", async () => {
  const dir = await testTemp("files-fetch-");
  try {
    const session = await files.open({ credentials: {}, http: { client: () => { throw new Error("none"); } }, files: await openLocalFiles(SIGNAGE), now: () => new Date(0) });
    const catalog = await session.scan();
    const welcome = catalog.media.find((item) => item.id === "images/welcome.png")!;
    const out = path.join(dir, "welcome.png");
    await session.fetchMedia(welcome, out);
    assert.deepEqual(await readFile(out), await readFile(path.join(SIGNAGE, "images", "welcome.png")));
    await assert.rejects(session.fetchMedia({ ...welcome, fetch: { entry: "images/gone.png" } }, path.join(dir, "gone.png")), /no longer in --files/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("csv headers may use synonyms, a byte order mark and CRLF; rows with problems are listed, not guessed", async () => {
  const dir = await testTemp("files-csv-");
  try {
    const png = await readFile(path.join(SIGNAGE, "images", "welcome.png"));
    await mkdir(path.join(dir, "a"));
    await mkdir(path.join(dir, "b"));
    await writeFile(path.join(dir, "a", "same.png"), png);
    await writeFile(path.join(dir, "b", "same.png"), png);
    await writeFile(path.join(dir, "only.png"), png);
    await writeFile(path.join(dir, "playlists.csv"), [
      "﻿Playlist,Filename,Seconds,Position",
      "Loop,only.png,abc,2",
      "Loop,a/same.png,7,1",
      "Loop,same.png,,3",
      "Loop,,,",
      ",orphan.png,,",
      "",
    ].join("\r\n"));
    await writeFile(path.join(dir, "screens.csv"), [
      "Name,Tags,Playlist,TimeZone",
      "Hall,A; B ;a,Loop,Mars/Olympus",
      "Hall,,Nowhere,",
      ",,,",
      "",
    ].join("\n"));
    const catalog = await scan(dir);
    assert.deepEqual(catalog.playlists, [{ id: "Loop", name: "Loop", items: [{ media_id: "a/same.png", duration_s: 7 }, { media_id: "only.png" }], notes: [] }]);
    assert.deepEqual(catalog.not_imported.map((entry) => [entry.source_id, entry.reason]), [
      ["playlists.csv row 4", "More than one file has this name; give its path from the root of --files."],
      ["playlists.csv row 5", "The row has no file."],
      ["playlists.csv row 6", "The row has no playlist name."],
    ]);
    assert.deepEqual(catalog.notes, ['playlists.csv row 2: the duration "abc" is not a number of seconds; the default is used.']);
    assert.deepEqual(catalog.groups, [{ id: "A", name: "A" }, { id: "B", name: "B" }]);
    assert.deepEqual(catalog.screens, [
      { id: "Hall", name: "Hall", group_ids: ["A", "B"], content: { playlist_id: "Loop" }, notes: ['The time zone "Mars/Olympus" is not an IANA name such as America/Toronto, so none is set.'] },
      { id: "Hall (2)", name: "Hall", group_ids: [], notes: ['The playlist "Nowhere" is not among the playlists, so it has no default playlist.'] },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("playlists.csv alone defines the playlists, and screens.csv alone picks from the folder playlists by name", async () => {
  const dir = await testTemp("files-one-csv-");
  try {
    const png = await readFile(path.join(SIGNAGE, "images", "welcome.png"));
    await mkdir(path.join(dir, "halls", "east"), { recursive: true });
    await writeFile(path.join(dir, "a.png"), png);
    await writeFile(path.join(dir, "halls", "east", "b.png"), png);
    await writeFile(path.join(dir, "playlists.csv"), "playlist,file,duration\nOnly,a.png,3\n");
    const playlistsOnly = await scan(dir);
    assert.deepEqual(playlistsOnly.playlists, [{ id: "Only", name: "Only", items: [{ media_id: "a.png", duration_s: 3 }], notes: [] }]);
    assert.deepEqual([playlistsOnly.screens, playlistsOnly.groups], [[], []]);
    await rm(path.join(dir, "playlists.csv"));
    await writeFile(path.join(dir, "screens.csv"), "name,playlist\nHall,halls / east\nEast,EAST\nLobby,\n");
    const screensOnly = await scan(dir);
    assert.deepEqual(screensOnly.playlists.map((playlist) => [playlist.id, playlist.name]), [["(root)", path.basename(dir)], ["halls/east", "halls / east"]]);
    assert.deepEqual(screensOnly.screens.map((screen) => [screen.id, screen.content]), [
      ["Hall", { playlist_id: "halls/east" }], ["East", { playlist_id: "halls/east" }], ["Lobby", undefined],
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a csv without its required column is a usage error naming the spellings", async () => {
  const dir = await testTemp("files-csv-bad-");
  try {
    await writeFile(path.join(dir, "a.png"), await readFile(path.join(SIGNAGE, "images", "welcome.png")));
    await writeFile(path.join(dir, "screens.csv"), "label,group\nHall,A\n");
    await assert.rejects(scan(dir), /screens\.csv needs a name column/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("files needs --files, and an empty folder scans to nothing", async () => {
  await assert.rejects(files.open({ credentials: {}, http: { client: () => { throw new Error("none"); } }, now: () => new Date(0) }), /--from files needs --files/);
  const dir = await testTemp("files-empty-");
  try {
    const catalog = await scan(dir);
    assert.deepEqual([catalog.media, catalog.playlists, catalog.not_imported], [[], [], []]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

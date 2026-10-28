import assert from "node:assert/strict";
import { test } from "node:test";
import { csvTable, parseCsv } from "./csv.js";

test("parseCsv reads quoted fields with commas, quotes and line breaks", () => {
  assert.deepEqual(parseCsv('a,b,c\n"x, y","say ""hi""","two\nlines"\n'), [["a", "b", "c"], ["x, y", 'say "hi"', "two\nlines"]]);
});

test("parseCsv accepts CRLF, CR and LF rows, a byte order mark and a missing final newline", () => {
  assert.deepEqual(parseCsv("﻿a,b\r\n1,2\r\n3,4"), [["a", "b"], ["1", "2"], ["3", "4"]]);
  assert.deepEqual(parseCsv("a,b\r1,2\r"), [["a", "b"], ["1", "2"]]);
});

test("parseCsv skips blank lines but keeps a quoted empty field and empty cells", () => {
  assert.deepEqual(parseCsv("a,b\n\n1,\n,\n\"\"\n"), [["a", "b"], ["1", ""], ["", ""], [""]]);
});

test("parseCsv names the line of a quote that never closes", () => {
  assert.throws(() => parseCsv('a,b\n1,"oops\n2,3\n', "playlists.csv"), /playlists\.csv has a quote opened on line 2 that is never closed/);
});

test("csvTable matches columns by case and synonym and ignores unknown columns", () => {
  const table = csvTable("Playlist, Filename ,SECONDS,Extra\nLobby,a.png,5,x\nLobby,b.png,,y\n", {
    playlist: [], file: ["filename", "path"], duration: ["seconds"], order: ["position"],
  }, { label: "playlists.csv", required: ["playlist", "file"] });
  assert.deepEqual(table.rows.map((row) => row.values), [
    { playlist: "Lobby", file: "a.png", duration: "5" },
    { playlist: "Lobby", file: "b.png", duration: "" },
  ]);
  assert.deepEqual(table.rows.map((row) => row.row), [2, 3]);
});

test("csvTable names the spellings of a missing required column", () => {
  assert.throws(
    () => csvTable("name,group\nA,B\n", { playlist: [], file: ["filename"] }, { label: "playlists.csv", required: ["playlist"] }),
    /playlists\.csv needs a playlist column \(playlist\).*"name", "group"/,
  );
});

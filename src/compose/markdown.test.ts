import assert from "node:assert/strict";
import { test } from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { parseMarkdown, stripMarkdown, wrapMarkdown } from "./markdown.js";
import { resolveFontFamily } from "./fonts.js";

test("markdown parses bold, italic, underline, and nested bold italic", () => {
  assert.deepEqual(parseMarkdown("**bold**"), [{ text: "bold", bold: true, italic: false, underline: false }]);
  assert.deepEqual(parseMarkdown("*italic*"), [{ text: "italic", bold: false, italic: true, underline: false }]);
  assert.deepEqual(parseMarkdown("__under__"), [{ text: "under", bold: false, italic: false, underline: true }]);
  assert.deepEqual(parseMarkdown("***both***"), [{ text: "both", bold: true, italic: true, underline: false }]);
  const nested = parseMarkdown("**bold *italic* still**");
  assert.deepEqual(nested, [
    { text: "bold ", bold: true, italic: false, underline: false },
    { text: "italic", bold: true, italic: true, underline: false },
    { text: " still", bold: true, italic: false, underline: false },
  ]);
});

test("unmatched markdown markers stay literal", () => {
  assert.equal(stripMarkdown("**bold"), "**bold");
  assert.equal(stripMarkdown("*italic"), "*italic");
  assert.equal(stripMarkdown("__under"), "__under");
  assert.equal(stripMarkdown("plain"), "plain");
});

test("wrap and measure strip markers so they do not consume width", () => {
  const family = resolveFontFamily(undefined);
  const ctx = createCanvas(8, 8).getContext("2d");
  const marked = wrapMarkdown(ctx, "**hello world**", 10000, 24, family);
  const plain = wrapMarkdown(ctx, "hello world", 10000, 24, family);
  assert.equal(marked.map((line) => line.map((span) => span.text).join("")).join("\n"), "hello world");
  assert.equal(plain.map((line) => line.map((span) => span.text).join("")).join("\n"), "hello world");
});

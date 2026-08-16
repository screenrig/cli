import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEVICE_PREFIXES,
  GENERIC_STEMS,
  NOISE_SUFFIXES,
  lowInformationFilenameWarning,
} from "./media-filename.js";

const WARNING_BODY =
  "carries little information. The filename is how people identify this media in listings, playlists, and playback reports, so ask for a distinctive name and upload again if that matters.";

function warningFor(filename: string): string {
  return `Filename "${filename}" ${WARNING_BODY}`;
}

test("word lists stay reviewable as module-level constants", () => {
  assert.ok(GENERIC_STEMS.includes("video"));
  assert.ok(GENERIC_STEMS.includes("untitled"));
  assert.ok(NOISE_SUFFIXES.includes("final"));
  assert.ok(NOISE_SUFFIXES.includes("copy"));
  assert.ok(DEVICE_PREFIXES.includes("img"));
  assert.ok(DEVICE_PREFIXES.includes("gx"));
  assert.ok(DEVICE_PREFIXES.includes("screen recording"));
});

test("clearly generic names are flagged", () => {
  const flagged = [
    "video.mp4",
    "IMG_1234.jpg",
    "DSC_0001.jpg",
    "VID_20240101_120000.mp4",
    "MVI_1234.mov",
    "GX010001.mp4",
    "Screen Recording 2026-08-16 at 10.14.22.mov",
    "untitled.mp4",
    "final2.mp4",
    "copy.mp4",
    "video (1).mp4",
    "output-v1.mp4",
    "2024-01-01.mp4",
    "12345.mp4",
    "a.mp4",
    "new-video.mp4",
  ];
  for (const filename of flagged) {
    const message = lowInformationFilenameWarning(filename);
    assert.equal(message, warningFor(filename), filename);
  }
});

test("clearly good names are not flagged", () => {
  assert.equal(lowInformationFilenameWarning("lobby-welcome-loop.mp4"), null);
  assert.equal(lowInformationFilenameWarning("store-hours-winter-2026.png"), null);
});

test("conservative near-misses are not flagged", () => {
  const kept = [
    "lobby-welcome-loop.mp4",
    "video-wall-lobby.mp4",
    "IMG_Sunset_Overlook.jpg",
    "2026-summer-campaign.mp4",
    "promo.mp4",
    "final-cut-lobby.mp4",
  ];
  for (const filename of kept) {
    assert.equal(lowInformationFilenameWarning(filename), null, filename);
  }
});

test("the check is case-insensitive", () => {
  assert.equal(lowInformationFilenameWarning("VIDEO.MP4"), warningFor("VIDEO.MP4"));
});

test("the extension is not judged", () => {
  assert.equal(lowInformationFilenameWarning("lobby-welcome-loop.webm"), null);
});

test("the returned message contains the original filename verbatim", () => {
  const filename = "VIDEO.MP4";
  const message = lowInformationFilenameWarning(filename);
  assert.ok(message);
  assert.ok(message.includes(filename));
  assert.equal(message, warningFor(filename));
  assert.ok(!message.includes("video.mp4"));
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import * as guidance from "./guidance.js";

test("guidance exports plain JSON data only, so the release bundle can carry it compressed", () => {
  const exported = { ...guidance };
  assert.deepEqual(Object.keys(exported).sort(), ["GUIDANCE_EXAMPLES", "GUIDANCE_NOTES"]);
  assert.ok(isDeepStrictEqual(JSON.parse(JSON.stringify(exported)), exported));
});

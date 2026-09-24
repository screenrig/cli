import assert from "node:assert/strict";
import { test } from "node:test";
import { isResourceID, type ResourceIDKind } from "./generated/resource-ids.js";

for (const [kind, type] of Object.entries({project:"prj",agent:"agt",connection:"acn",screen:"scr",playlist:"pl",release:"rel"})) {
  test(`${kind} supports retained and environment-qualified IDs without accepting other resources`, () => {
    for (const prefix of ["", "development_", "qa_", "stage_"]) {
      for (const suffix of ["abcdefghijkmnpqr", "Legacy_ABC-123"]) {
        assert.ok(isResourceID(`${prefix}${type}_${suffix}`, kind as ResourceIDKind));
      }
      assert.equal(isResourceID(`${prefix}med_TEST`, kind as ResourceIDKind), false);
    }
    for (const id of [null, {}, `${type}_`, `unknown_${type}_TEST`, `development_qa_${type}_TEST`, `${type}_a/b`, `${type}_a?x`, `${type}_a\n`]) {
      assert.equal(isResourceID(id, kind as ResourceIDKind), false);
    }
  });
}
test("content-derived media identifiers do not acquire environment markers", () => {
  assert.ok(isResourceID("med_" + "a".repeat(64), "media"));
  for (const prefix of ["development_", "qa_", "stage_"]) assert.equal(isResourceID(prefix + "med_TEST", "media"), false);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSse } from "./sse.js";

for (const ending of ["\n", "\r\n", "\r"]) {
  test(`SSE parses ${JSON.stringify(ending)} line endings at every chunk boundary`, () => {
    const frame = ["id: ev1_1", "event: message", "data: {\"ok\":true}", "", ""].join(ending);
    for (let split = 0; split <= frame.length; split += 1) {
      const first = parseSse(frame.slice(0, split));
      const second = parseSse(first.rest + frame.slice(split));
      assert.deepEqual([...first.events, ...second.events], [{ id: "ev1_1", event: "message", data: '{"ok":true}' }], `split ${split}`);
      assert.equal(second.rest, "");
    }
  });
}

test("SSE ignores comment lines without dropping the following event", () => {
  assert.deepEqual(parseSse(': keepalive\nid: ev1_2\ndata: ready\n\n'), {
    events: [{ id: "ev1_2", data: "ready" }], rest: "",
  });
});

test("SSE preserves data whitespace and empty lines and rejects NUL cursors", () => {
  assert.deepEqual(parseSse('id: cursor \nid: invalid\0cursor\ndata:\ndata:  indented  \ndata\n\n'), {
    events: [{ id: "cursor ", data: "\n indented  \n" }], rest: "",
  });
});

test("SSE retains an incomplete frame and ignores comment-only frames", () => {
  assert.deepEqual(parseSse(': keepalive\n\nid: ev1_3\ndata: partial'), {
    events: [], rest: 'id: ev1_3\ndata: partial',
  });
});

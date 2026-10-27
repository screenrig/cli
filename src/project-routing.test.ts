import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgv } from "./argv.js";
import { ApiClient } from "./client.js";
import { projectRequest, projectStreamQuery } from "./project-routing.js";
import { fakeSessionJwt, FakeTransport } from "./transport/fake.js";

const id = "prj_SELECTED";
const prefix = `/api/projects/${id}`;

test("object-less writes and local names use project parents, while object IDs remain global", () => {
  for (const [method, path] of [["POST", "/api/applications"], ["POST", "/api/playlists"], ["POST", "/api/cards"], ["POST", "/api/media/uploads"], ["POST", "/api/media/generations"], ["PUT", "/api/card-data/menu"], ["GET", "/api/feeds/weather"], ["GET", "/api/project"], ["POST", "/api/service-clients"], ["GET", "/api/campaigns"], ["POST", "/api/campaigns"], ["GET", "/api/advertising/direct-campaigns"], ["POST", "/api/advertising/direct-campaigns"], ["POST", "/api/advertising/availability"], ["GET", "/api/advertising/reports/fill"], ["GET", "/api/notifications"], ["POST", "/api/notifications"], ["GET", "/api/alerts"], ["GET", "/api/alert-mutes"], ["POST", "/api/alert-mutes"]] as const) {
    assert.equal(projectRequest({ method, path }, id).path, prefix + path.slice(4));
  }
  for (const path of ["/api/cards/crd_CARD", "/api/cards/crd_CARD/data", "/api/screens/scr_SCREEN", "/api/applications/app_APP/kv/name", "/api/playlists/pl_PLAYLIST", "/api/operations/op_OPERATION", "/api/service-clients/scl_CLIENT/revoke", "/api/advertising/direct-campaigns/adc_CAMPAIGN", "/api/advertising/direct-campaigns/adc_CAMPAIGN/report", "/api/projects", "/api/organizations", "/api/campaigns/cmp_CAMPAIGN", "/api/campaigns/cmp_CAMPAIGN/screens", "/api/screens/scr_SCREEN/campaigns", "/api/notifications/ntf_NOTIFICATION", "/api/notifications/ntf_NOTIFICATION/deliveries", "/api/alerts/alr_ALERT", "/api/alerts/alr_ALERT/acknowledge", "/api/alert-mutes/amt_MUTE"]) {
    assert.equal(projectRequest({ method: "GET", path }, id).path, path);
  }
});

test("list and catalogue narrowing preserves filters; no selection leaves the server to decide", () => {
  for (const path of ["/api/screens", "/api/cards", "/api/media", "/api/playlists", "/api/applications", "/api/notes", "/api/card-types", "/api/card-types/menu"]) {
    const request = { method: "GET" as const, path, query: { after: "cursor" } };
    assert.deepEqual(projectRequest(request, id), { ...request, query: { after: "cursor", project: id } });
    assert.deepEqual(projectRequest(request), request);
  }
  assert.deepEqual(projectStreamQuery(id), { project: id });
});

test("subset clients route writes before recovery and never send an ambient project header", async () => {
  const token = fakeSessionJwt({ exp: 4102444800, projects: { [id]: ["content"] }, scope: "identity" });
  const transport = new FakeTransport().on("POST", `${prefix}/applications`, req => {
    assert.equal(req.headers?.["screenrig-project"], undefined);
    assert.ok(req.headers?.["idempotency-key"]);
    return { status: 201, headers: {}, body: { id: "app_NEW" } };
  });
  await new ApiClient({ token, projectId: id, transport }).call({ method: "POST", path: "/api/applications", body: { name: "Menu" }, idempotent: true });
});

test("a subset client lists and creates notifications under its project and addresses one by id", async () => {
  const token = fakeSessionJwt({ exp: 4102444800, projects: { [id]: ["content"] }, scope: "identity" });
  const transport = new FakeTransport()
    .on("GET", `${prefix}/notifications`, () => ({ status: 200, headers: {}, body: { items: [] } }))
    .on("POST", `${prefix}/notifications`, () => ({ status: 201, headers: {}, body: { id: "ntf_NOTIFICATIONAAAAAA" } }))
    .on("GET", "/api/notifications/ntf_NOTIFICATIONAAAAAA", () => ({ status: 200, headers: {}, body: { id: "ntf_NOTIFICATIONAAAAAA" } }));
  const client = new ApiClient({ token, projectId: id, transport });
  await client.call({ method: "GET", path: "/api/notifications" });
  await client.call({ method: "POST", path: "/api/notifications", body: { channel: "email" }, idempotent: true });
  await client.call({ method: "GET", path: "/api/notifications/ntf_NOTIFICATIONAAAAAA" });
  assert.deepEqual(transport.calls.map((call) => `${call.method} ${call.path}`), [
    `GET ${prefix}/notifications`, `POST ${prefix}/notifications`, "GET /api/notifications/ntf_NOTIFICATIONAAAAAA",
  ]);
});


test("a subset client lists alerts and creates mutes under its project and addresses one alert or mute by id", async () => {
  const token = fakeSessionJwt({ exp: 4102444800, projects: { [id]: ["content"] }, scope: "identity" });
  const transport = new FakeTransport()
    .on("GET", `${prefix}/alerts`, () => ({ status: 200, headers: {}, body: { items: [], next_cursor: null, counts: { open: 0, attention: 0 } } }))
    .on("GET", `${prefix}/alert-mutes`, () => ({ status: 200, headers: {}, body: { items: [] } }))
    .on("POST", `${prefix}/alert-mutes`, () => ({ status: 201, headers: {}, body: { id: "amt_MUTEAAAAAAAAAAAAAAAA" } }))
    .on("GET", "/api/alerts/alr_ALERTAAAAAAAAAAAAAAA", () => ({ status: 200, headers: {}, body: { id: "alr_ALERTAAAAAAAAAAAAAAA" } }))
    .on("POST", "/api/alerts/alr_ALERTAAAAAAAAAAAAAAA/acknowledge", () => ({ status: 200, headers: {}, body: { id: "alr_ALERTAAAAAAAAAAAAAAA" } }))
    .on("DELETE", "/api/alert-mutes/amt_MUTEAAAAAAAAAAAAAAAA", () => ({ status: 204, headers: {}, body: undefined }));
  const client = new ApiClient({ token, projectId: id, transport });
  await client.call({ method: "GET", path: "/api/alerts" });
  await client.call({ method: "GET", path: "/api/alert-mutes" });
  await client.call({ method: "POST", path: "/api/alert-mutes", body: { tags: ["Lobby"], until: "2026-11-01T16:00:00Z" }, idempotent: true });
  await client.call({ method: "GET", path: "/api/alerts/alr_ALERTAAAAAAAAAAAAAAA" });
  await client.call({ method: "POST", path: "/api/alerts/alr_ALERTAAAAAAAAAAAAAAA/acknowledge", idempotent: true });
  await client.call({ method: "DELETE", path: "/api/alert-mutes/amt_MUTEAAAAAAAAAAAAAAAA", idempotent: true });
  assert.deepEqual(transport.calls.map((call) => `${call.method} ${call.path}`), [
    `GET ${prefix}/alerts`, `GET ${prefix}/alert-mutes`, `POST ${prefix}/alert-mutes`, "GET /api/alerts/alr_ALERTAAAAAAAAAAAAAAA",
    "POST /api/alerts/alr_ALERTAAAAAAAAAAAAAAA/acknowledge", "DELETE /api/alert-mutes/amt_MUTEAAAAAAAAAAAAAAAA",
  ]);
});

test("project token native options reject invalid subsets before authentication", () => {
  for (const value of [" ", "bad", "prj_A,prj_A", Array.from({length: 65}, (_, i) => `prj_${i}`).join(",")]) {
    assert.throws(() => parseArgv(["project", "token", "--projects", value]));
  }
  assert.equal(parseArgv(["project", "token", "--projects", "prj_A prj_B"]).flags.projects, "prj_A,prj_B");
});

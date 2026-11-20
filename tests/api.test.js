import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../dev-server.js";
import { setStore } from "../api/index.js";
import { memoryStore } from "../server/store.js";
import { CENTER } from "../server/renju.js";

let server;
let base;
before(async () => {
  setStore(memoryStore());
  server = createApp();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.closeAllConnections?.();
  server.close();
});

const PA = "player_aaaaaaaa";
const PB = "player_bbbbbbbb";
async function call(method, path, body) {
  const r = await fetch(base + path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, json: await r.json() };
}

/** read SSE `room` events until pred(room) is true */
async function waitEvent(id, playerId, pred, timeout = 5000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  const r = await fetch(`${base}/api/rooms/${id}/stream?playerId=${playerId}`, { signal: ac.signal });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /event: (\w+)/.exec(block)?.[1];
        const data = /data: (.*)/.exec(block)?.[1];
        if (ev === "room") {
          const room = JSON.parse(data);
          if (pred(room)) return room;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  throw new Error("no matching event");
}

test("create, list, join by link, sync a move to the other client, reconnect", async () => {
  const c = await call("POST", "/api/rooms", { playerId: PA, nickname: " 앨리스 ", name: "", rule: "renju" });
  assert.equal(c.status, 201);
  const id = c.json.room.id;
  assert.equal(c.json.room.me, "black");
  assert.equal(c.json.room.status, "waiting");
  assert.equal(c.json.room.centerOnly, false);

  const list = await call("GET", "/api/rooms");
  assert.ok(list.json.rooms.some((r) => r.id === id && r.players === 1 && r.rule === "renju"));

  const j = await call("POST", `/api/rooms/${id}/join`, { playerId: PB, nickname: "밥" });
  assert.equal(j.json.seat, "white");
  assert.equal(j.json.room.status, "playing");

  // B listens, A plays the center
  const seen = waitEvent(id, PB, (room) => room.lastMove === CENTER);
  const m = await call("POST", `/api/rooms/${id}/move`, { playerId: PA, idx: CENTER });
  assert.equal(m.status, 200);
  const got = await seen;
  assert.equal(got.board[CENTER], 1);
  assert.equal(got.turn, 2);
  assert.equal(got.me, "white");

  // reconnect (page reload): same token gets the same seat back
  const again = await call("GET", `/api/rooms/${id}?playerId=${PB}`);
  assert.equal(again.json.room.me, "white");
  const rejoin = await call("POST", `/api/rooms/${id}/join`, { playerId: PA, nickname: "앨리스" });
  assert.equal(rejoin.json.seat, "black");
  assert.equal(rejoin.json.room.moveCount, 1);
});

test("two simultaneous moves: only one lands", async () => {
  const id = (await call("POST", "/api/rooms", { playerId: PA, nickname: "A", rule: "free" })).json.room.id;
  await call("POST", `/api/rooms/${id}/join`, { playerId: PB, nickname: "B" });
  const [r1, r2] = await Promise.all([
    call("POST", `/api/rooms/${id}/move`, { playerId: PA, idx: 0 }),
    call("POST", `/api/rooms/${id}/move`, { playerId: PA, idx: 1 }),
  ]);
  assert.deepEqual([r1.status, r2.status].sort(), [200, 409]);
  const room = (await call("GET", `/api/rooms/${id}?playerId=${PA}`)).json.room;
  assert.equal(room.moveCount, 1);
  assert.equal(room.turn, 2);
});

test("forbidden and invalid requests", async () => {
  const id = (await call("POST", "/api/rooms", { playerId: PA, nickname: "A", rule: "renju" })).json.room.id;
  await call("POST", `/api/rooms/${id}/join`, { playerId: PB, nickname: "B" });
  const off = await call("POST", `/api/rooms/${id}/move`, { playerId: PA, idx: 0 });
  assert.equal(off.status, 409);
  assert.equal(off.json.error.reason, "렌주룰: 흑 첫 수는 중앙");
  assert.equal((await call("POST", `/api/rooms/${id}/move`, { playerId: PA, idx: "x" })).status, 400);
  assert.equal((await call("POST", `/api/rooms/${id}/move`, { playerId: PA, idx: 999 })).status, 400);
  assert.equal((await call("POST", `/api/rooms/${id}/move`, { playerId: "bad", idx: 1 })).status, 400);
  assert.equal((await call("GET", `/api/rooms/zzzzzzzz`)).status, 404);
  assert.equal((await call("POST", `/api/rooms`, { playerId: PA, nickname: "   " })).status, 400);
});

const PC = "player_cccccccc";

/** read SSE events of any type until pred(event, data) */
async function waitAny(id, playerId, pred, timeout = 9000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  const r = await fetch(`${base}/api/rooms/${id}/stream?playerId=${playerId}`, { signal: ac.signal });
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /event: (\w+)/.exec(block)?.[1];
        const data = /data: (.*)/.exec(block)?.[1];
        if (ev && data && pred(ev, JSON.parse(data))) return JSON.parse(data);
      }
    }
  } finally {
    clearTimeout(timer);
    ac.abort();
  }
  throw new Error("no matching event");
}

test("secret room: listed, password checked on join, strangers cannot read it", async () => {
  const c = await call("POST", "/api/rooms", { playerId: PA, nickname: "A", rule: "free", password: "4321", timeLimit: 30 });
  assert.equal(c.status, 201);
  const id = c.json.room.id;
  assert.equal(c.json.room.locked, true);
  assert.equal(c.json.room.timeLimit, 30);
  const list = await call("GET", "/api/rooms");
  assert.equal(list.json.rooms.find((r) => r.id === id).locked, true);
  const peek = await call("GET", `/api/rooms/${id}?playerId=${PB}`);
  assert.equal(peek.status, 403);
  assert.equal(peek.json.error.code, "password");
  assert.equal(peek.json.error.room.name, "A의 방");
  assert.equal(peek.json.error.room.board, undefined);
  const wrong = await call("POST", `/api/rooms/${id}/join`, { playerId: PB, nickname: "B", password: "0000" });
  assert.equal(wrong.status, 403);
  const j = await call("POST", `/api/rooms/${id}/join`, { playerId: PB, nickname: "B", password: "4321" });
  assert.equal(j.json.seat, "white");
  assert.ok(j.json.room.deadline > Date.now() + 25_000);
  assert.equal((await call("GET", `/api/rooms/${id}?playerId=${PB}`)).status, 200);
  // a wrong guess must not show up as a spectator
  await call("POST", `/api/rooms/${id}/join`, { playerId: PC, nickname: "몰래", password: "nope" });
  const seenBy = await call("GET", `/api/rooms/${id}?playerId=${PA}`);
  assert.deepEqual(seenBy.json.room.spectators, []);
  const short = await call("POST", "/api/rooms", { playerId: PA, nickname: "A", rule: "free", password: "12" });
  assert.equal(short.status, 400);
});

test("spectator shows up in presence; reactions and rematch decline reach the other side", async () => {
  const id = (await call("POST", "/api/rooms", { playerId: PA, nickname: "앨리스", rule: "free" })).json.room.id;
  await call("POST", `/api/rooms/${id}/join`, { playerId: PB, nickname: "밥" });
  const spec = await call("POST", `/api/rooms/${id}/join`, { playerId: PC, nickname: "찰리" });
  assert.equal(spec.json.seat, null);
  const pres = await waitAny(id, PA, (ev) => ev === "presence");
  assert.deepEqual(pres.spectators, ["찰리"]);
  assert.equal(pres.online.white, true);

  const got = waitAny(id, PA, (ev, d) => ev === "room" && d.reaction?.emoji === "🔥");
  const r = await call("POST", `/api/rooms/${id}/react`, { playerId: PC, nickname: "찰리", emoji: "🔥" });
  assert.equal(r.status, 200);
  const room = await got;
  assert.equal(room.reaction.name, "찰리");
  assert.equal((await call("POST", `/api/rooms/${id}/react`, { playerId: PC, nickname: "찰리", emoji: "👍" })).status, 429);

  await call("POST", `/api/rooms/${id}/resign`, { playerId: PB });
  await call("POST", `/api/rooms/${id}/rematch`, { playerId: PA });
  const d = await call("POST", `/api/rooms/${id}/decline`, { playerId: PB });
  assert.equal(d.json.room.rematch.declined, 1);
  const kicked = await call("POST", `/api/rooms/${id}/kick`, { playerId: PA });
  assert.equal(kicked.status, 200);
  assert.equal(kicked.json.room.seats.white, null);
  const back = await call("POST", `/api/rooms/${id}/join`, { playerId: PB, nickname: "밥" });
  assert.equal(back.json.seat, null);
});

test("last player leaving deletes the room: not listed, link no longer works", async () => {
  const id = (await call("POST", "/api/rooms", { playerId: PA, nickname: "A", rule: "free" })).json.room.id;
  assert.ok((await call("GET", "/api/rooms")).json.rooms.some((r) => r.id === id));
  const l = await call("POST", `/api/rooms/${id}/leave`, { playerId: PA });
  assert.equal(l.status, 200);
  assert.equal((await call("GET", "/api/rooms")).json.rooms.some((r) => r.id === id), false);
  assert.equal((await call("GET", `/api/rooms/${id}?playerId=${PB}`)).status, 404);
  assert.equal((await call("POST", `/api/rooms/${id}/join`, { playerId: PB, nickname: "B" })).status, 404);
});

test("one of two leaving keeps the room for the other", async () => {
  const id = (await call("POST", "/api/rooms", { playerId: PA, nickname: "A", rule: "free" })).json.room.id;
  await call("POST", `/api/rooms/${id}/join`, { playerId: PB, nickname: "B" });
  await call("POST", `/api/rooms/${id}/leave`, { playerId: PB });
  const r = await call("GET", `/api/rooms/${id}?playerId=${PA}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.room.status, "ended"); // B left mid-game = resign; A still sees the result
  assert.equal(r.json.room.result.reason, "백 기권");
  const listed = (await call("GET", "/api/rooms")).json.rooms.find((x) => x.id === id);
  assert.equal(listed.status, "waiting"); // lobby shows it as joinable
});

test("admin: login, logs with ip and device, ban blocks the player api", async () => {
  const { setAdminConfig } = await import("../server/admin.js");
  setAdminConfig({ id: "boss", password: "pw-1234", secret: "test-secret-xyz" });
  const H = { "Content-Type": "application/json", "X-Real-IP": "203.0.113.7", "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile/15E148 Safari/604.1" };
  const post = (path, body, headers = H) =>
    fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, json: await r.json() }));
  const id = (await post("/api/rooms", { playerId: "player_iplogged1", nickname: "기록됨", rule: "free" })).json.room.id;

  assert.equal((await call("GET", "/api/admin/logs")).status, 401);
  assert.equal((await call("POST", "/api/admin/login", { id: "boss", password: "nope" })).status, 401);
  const login = await call("POST", "/api/admin/login", { id: "boss", password: "pw-1234" });
  assert.equal(login.status, 200);
  const auth = { "Content-Type": "application/json", Authorization: `Bearer ${login.json.token}` };
  const get = (path) => fetch(base + path, { headers: auth }).then(async (r) => ({ status: r.status, json: await r.json() }));

  const logs = await get("/api/admin/logs?ip=203.0.113.7");
  const created = logs.json.logs.find((l) => l.type === "create" && l.room === id);
  assert.ok(created, JSON.stringify(logs.json));
  assert.equal(created.name, "기록됨");
  assert.equal(created.device, "휴대폰 · iOS · Safari");
  assert.ok((await get("/api/admin/rooms")).json.rooms.some((r) => r.id === id));
  assert.ok((await get("/api/admin/stats")).json.todayIps >= 1);

  const b = await fetch(base + "/api/admin/ban", { method: "POST", headers: auth, body: JSON.stringify({ ip: "203.0.113.7", reason: "테스트" }) });
  assert.equal(b.status, 200);
  const blocked = await post("/api/rooms", { playerId: "player_iplogged1", nickname: "기록됨", rule: "free" });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.error.code, "banned");
  await fetch(base + "/api/admin/unban", { method: "POST", headers: auth, body: JSON.stringify({ ip: "203.0.113.7" }) });
  assert.equal((await post("/api/rooms", { playerId: "player_iplogged1", nickname: "기록됨", rule: "free" })).status, 201);
  setAdminConfig(null);
});

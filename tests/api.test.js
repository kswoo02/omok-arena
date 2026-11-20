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

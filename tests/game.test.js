import { test } from "node:test";
import assert from "node:assert/strict";
import { newRoom, join, move, resign, leave, rematch, view, cleanName } from "../server/game.js";
import { memoryStore } from "../server/store.js";
import { CENTER } from "../server/renju.js";

const A = { id: "pa", name: "앨리스" };
const Bp = { id: "pb", name: "밥" };
const C = { id: "pc", name: "찰리" };

function playing(rule = "renju") {
  let room = newRoom({ id: "r1", name: "", rule, player: A });
  room = join(room, Bp).room;
  return room;
}
const ok = (r) => {
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return r.room;
};

test("cleanName trims and limits to 12 chars", () => {
  assert.equal(cleanName("  김  선우  "), "김 선우");
  assert.equal(cleanName("a".repeat(30)).length, 12);
  assert.equal(cleanName("   "), "");
  assert.equal(cleanName(undefined), "");
});

test("creator is black, joiner white, game starts when both seated", () => {
  let room = newRoom({ id: "r1", name: "", rule: "renju", player: A });
  assert.equal(room.status, "waiting");
  assert.equal(room.name, "앨리스의 방");
  room = join(room, Bp).room;
  assert.equal(room.seats.black.id, "pa");
  assert.equal(room.seats.white.id, "pb");
  assert.equal(room.status, "playing");
  assert.equal(room.turn, 1);
});

test("rejoin returns the same seat; third player spectates", () => {
  let room = playing();
  const again = join(room, { id: "pb", name: "밥2" });
  assert.equal(again.seat, "white");
  const spec = join(room, C);
  assert.equal(spec.seat, null);
  assert.equal(spec.room.seats.white.id, "pb");
});

test("turns, wrong turn, spectator and occupied are rejected", () => {
  let room = playing();
  assert.equal(move(room, "pb", CENTER).error.code, "turn");
  assert.equal(move(room, "pc", CENTER).error.code, "seat");
  room = ok(move(room, "pa", CENTER));
  assert.equal(room.turn, 2);
  assert.equal(move(room, "pb", CENTER).error.code, "occupied");
  assert.equal(move(room, "pb", 225).error.code, "invalid");
  assert.equal(move(room, "pb", "3").error.code, "invalid");
});

test("renju forbidden move is rejected with reason, not a loss", () => {
  let room = playing();
  // black (7,7),(8,7),(9,5),(9,6); then (9,7) makes row 7-9 and column 5-7 threes -> 3-3
  const seq = [[7, 7], [0, 0], [8, 7], [0, 2], [9, 5], [0, 4], [9, 6], [14, 14]];
  for (const [i, [x, y]] of seq.entries()) {
    room = ok(move(room, i % 2 ? "pb" : "pa", y * 15 + x));
  }
  const T = 7 * 15 + 9;
  const r = move(room, "pa", T);
  assert.equal(r.error.code, "33");
  assert.equal(r.error.reason, "흑 3·3 금수");
  assert.equal(room.status, "playing");
  assert.ok(view(room, "pa").forbidden.some((f) => f.idx === T));
  assert.deepEqual(view(room, "pb").forbidden, view(room, "pa").forbidden); // public info
});

test("win ends the game with winner, reason and line", () => {
  let room = playing("free");
  const black = [0, 1, 2, 3, 4].map((x) => 7 * 15 + x);
  const white = [0, 1, 2, 3].map((x) => 9 * 15 + x);
  for (let i = 0; i < 4; i++) {
    room = ok(move(room, "pa", black[i]));
    room = ok(move(room, "pb", white[i]));
  }
  room = ok(move(room, "pa", black[4]));
  assert.equal(room.status, "ended");
  assert.equal(room.result.winner, 1);
  assert.equal(room.result.reason, "흑 5목 승리");
  assert.deepEqual(room.result.line, black);
  assert.equal(move(room, "pb", 0).error.code, "ended");
});

test("resign and leave", () => {
  let room = playing();
  room = ok(resign(room, "pa"));
  assert.equal(room.status, "ended");
  assert.equal(room.result.winner, 2);
  assert.equal(room.result.reason, "흑 기권");
  room = ok(leave(room, "pb"));
  assert.equal(room.seats.white, null);
  assert.equal(room.status, "waiting");
  room = join(room, C).room;
  assert.equal(room.seats.white.id, "pc");
  assert.equal(room.status, "playing");
  assert.equal(room.moves.length, 0);
});

test("leaving during play counts as resign", () => {
  let room = playing();
  room = ok(move(room, "pa", CENTER));
  room = ok(leave(room, "pb"));
  assert.equal(room.result.winner, 1);
  assert.equal(room.result.reason, "백 기권");
  assert.equal(room.seats.white, null);
});

test("rematch needs both and swaps colors", () => {
  let room = playing();
  room = ok(resign(room, "pb"));
  room = ok(rematch(room, "pa"));
  assert.equal(room.status, "ended");
  assert.equal(view(room, "pa").rematch.mine, true);
  room = ok(rematch(room, "pb"));
  assert.equal(room.status, "playing");
  assert.equal(room.seats.black.id, "pb");
  assert.equal(room.seats.white.id, "pa");
  assert.equal(room.moves.length, 0);
});

test("view hides player tokens and marks my seat", () => {
  const room = playing();
  const v = view(room, "pb");
  assert.equal(v.me, "white");
  assert.equal(JSON.stringify(v).includes("pa"), false);
  assert.equal(v.seats.black.name, "앨리스");
  assert.equal(view(room, "zz").me, null);
});

test("memory store compare-and-set allows only one writer per version", async () => {
  const s = memoryStore();
  const room = newRoom({ id: "r9", name: "", rule: "free", player: A });
  assert.equal(await s.put({ ...room, version: 1 }, 0), true);
  assert.equal(await s.put({ ...room, version: 1 }, 0), false); // second create
  const cur = await s.get("r9");
  const a = await s.put({ ...cur, version: 2 }, 1);
  const b = await s.put({ ...cur, version: 2 }, 1);
  assert.deepEqual([a, b], [true, false]);
  assert.equal(await s.version("r9"), 2);
  assert.equal(await s.get("nope"), null);
  const list = await s.list();
  assert.equal(list[0].id, "r9");
  assert.equal(list[0].players, 1);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  newRoom, join, move, leave, rematch, declineRematch, react, kick, settle, view, EMOJIS,
} from "../server/game.js";
import { memoryStore } from "../server/store.js";
import { CENTER } from "../server/renju.js";

const A = { id: "pa", name: "앨리스" };
const B = { id: "pb", name: "밥" };
const C = { id: "pc", name: "찰리" };
const T0 = 1_000_000;
const ok = (r) => {
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  return r.room;
};
function playing(opts = {}) {
  const room = newRoom({ id: "r1", name: "", rule: "free", player: A, now: T0, ...opts });
  return join(room, B, T0).room;
}

test("time limit sets a deadline and a late turn loses on settle", () => {
  let room = playing({ timeLimit: 30 });
  assert.equal(room.timeLimit, 30);
  assert.equal(room.deadline, T0 + 30_000);
  room = ok(move(room, "pa", CENTER, T0 + 5_000));
  assert.equal(room.deadline, T0 + 35_000);
  assert.equal(settle(room, T0 + 34_000), null);
  const late = settle(room, T0 + 35_500);
  assert.equal(late.status, "ended");
  assert.equal(late.result.winner, 1);
  assert.equal(late.result.reason, "백 시간 초과");
  assert.equal(late.deadline, null);
});

test("no time limit: no deadline, settle never ends the game", () => {
  const room = playing();
  assert.equal(room.timeLimit, 0);
  assert.equal(room.deadline, null);
  assert.equal(settle(room, T0 + 10 ** 9), null);
});

test("only 0, 30, 60 are accepted as time limits", () => {
  assert.equal(newRoom({ id: "x", name: "", rule: "free", player: A, timeLimit: 999 }).timeLimit, 0);
  assert.equal(newRoom({ id: "x", name: "", rule: "free", player: A, timeLimit: 60 }).timeLimit, 60);
});

test("reactions: allowed emojis only, 2 s per person, spectators too", () => {
  assert.deepEqual(EMOJIS, ["👍", "😮", "😂", "😭", "🔥", "👏"]);
  let room = playing();
  room = ok(react(room, A, "👍", T0));
  assert.equal(room.reaction.emoji, "👍");
  assert.equal(room.reaction.name, "앨리스");
  assert.equal(room.reaction.seat, "black");
  const seq = room.reaction.seq;
  assert.equal(react(room, A, "🔥", T0 + 1_000).error.code, "slow");
  room = ok(react(room, A, "🔥", T0 + 2_100));
  assert.equal(room.reaction.seq, seq + 1);
  room = ok(react(room, C, "😂", T0 + 2_200)); // spectator
  assert.equal(room.reaction.seat, null);
  assert.equal(react(room, B, "💩", T0 + 9_000).error.code, "emoji");
});

test("rematch request can be declined, and the requester learns it", () => {
  let room = playing();
  room = ok(leave(room, "zz")); // no-op
  room = { ...room, status: "ended", result: { winner: 1, reason: "흑 5목 승리", line: null } };
  room = ok(rematch(room, "pa", T0));
  assert.deepEqual(view(room, "pb").rematch, { count: 1, mine: false, fromOther: true, declined: 0 });
  room = ok(declineRematch(room, "pb"));
  assert.equal(room.rematch.length, 0);
  assert.equal(view(room, "pa").rematch.declined, 1);
  assert.equal(room.status, "ended");
});

test("owner can kick an idle opponent; kicked player only spectates afterwards", () => {
  let room = playing();
  assert.equal(view(room, "pa").owner, true);
  assert.equal(view(room, "pb").owner, false);
  // during play the target must be away for 45 s
  const fresh = { pb: { at: T0 + 50_000 } };
  assert.equal(kick(room, "pa", fresh, T0 + 60_000).error.code, "online");
  assert.equal(kick(room, "pb", {}, T0).error.code, "owner");
  room = ok(kick(room, "pa", { pb: { at: T0 } }, T0 + 60_000));
  assert.equal(room.seats.white, null);
  assert.equal(room.status, "waiting");
  assert.equal(room.result.reason, "백 기권");
  const back = join(room, B, T0 + 61_000);
  assert.equal(back.seat, null);
  assert.equal(join(room, C, T0 + 62_000).seat, "white");
});

test("kick after the game ends needs no idle time", () => {
  let room = playing();
  room = { ...room, status: "ended", result: { winner: 1, reason: "흑 5목 승리", line: null } };
  room = ok(kick(room, "pa", { pb: { at: T0 } }, T0 + 1));
  assert.equal(room.seats.white, null);
});

test("ownership passes to the remaining player when the owner leaves", () => {
  let room = playing();
  room = ok(leave(room, "pa"));
  assert.equal(view(room, "pb").owner, true);
});

test("private rooms are not listed", async () => {
  const s = memoryStore();
  const pub = { ...newRoom({ id: "pub1", name: "", rule: "free", player: A }), version: 1 };
  const prv = { ...newRoom({ id: "prv1", name: "", rule: "free", player: A, private: true }), version: 1 };
  await s.put(pub, 0);
  await s.put(prv, 0);
  const ids = (await s.list()).map((r) => r.id);
  assert.deepEqual(ids, ["pub1"]);
  assert.equal(view(prv, "pa").private, true);
});

test("presence: touch and seen", async () => {
  const s = memoryStore();
  await s.touch("r1", "pa", { name: "앨리스", at: T0 });
  await s.touch("r1", "pc", { name: "찰리", at: T0 + 5 });
  const seen = await s.seen("r1");
  assert.equal(seen.pa.name, "앨리스");
  assert.equal(seen.pc.at, T0 + 5);
});

test("view lists spectators and online state from presence", () => {
  const room = playing();
  const seen = { pa: { name: "앨리스", at: T0 }, pc: { name: "찰리", at: T0 }, pd: { name: "옛날", at: T0 - 120_000 } };
  const v = view(room, "pa", { seen, now: T0 + 10_000 });
  assert.deepEqual(v.spectators, ["찰리"]);
  assert.equal(v.seats.black.online, true);
  assert.equal(v.seats.white.online, false);
  assert.equal(typeof v.serverNow, "number");
});

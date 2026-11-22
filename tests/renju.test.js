import { test } from "node:test";
import assert from "node:assert/strict";
import { SIZE, CENTER, judge, forbiddenPoints } from "../server/renju.js";

const B = 1;
const W = 2;
const at = (x, y) => y * SIZE + x;

/** board from lists of [x, y] */
function board({ black = [], white = [] } = {}) {
  const b = new Array(SIZE * SIZE).fill(0);
  for (const [x, y] of black) b[at(x, y)] = B;
  for (const [x, y] of white) b[at(x, y)] = W;
  return b;
}
const row = (y, xs) => xs.map((x) => [x, y]);
const col = (x, ys) => ys.map((y) => [x, y]);

test("constants", () => {
  assert.equal(SIZE, 15);
  assert.equal(CENTER, 112);
});

test("black exact five wins with the line", () => {
  const r = judge(board({ black: row(7, [3, 4, 5, 6]) }), at(7, 7), B, "renju", 10);
  assert.equal(r.ok, true);
  assert.equal(r.win, true);
  assert.deepEqual([...r.line].sort((a, b) => a - b), [3, 4, 5, 6, 7].map((x) => at(x, 7)));
});

test("black overline is forbidden in renju", () => {
  const r = judge(board({ black: row(7, [2, 3, 4, 5, 7]) }), at(6, 7), B, "renju", 10);
  assert.equal(r.ok, false);
  assert.equal(r.code, "overline");
  assert.equal(r.reason, "흑 장목(6목 이상) 금수");
});

test("white overline wins in renju", () => {
  const r = judge(board({ white: row(7, [2, 3, 4, 5, 7]) }), at(6, 7), W, "renju", 10);
  assert.equal(r.ok, true);
  assert.equal(r.win, true);
});

test("free rule: black six wins", () => {
  const r = judge(board({ black: row(7, [2, 3, 4, 5, 7]) }), at(6, 7), B, "free", 10);
  assert.equal(r.ok, true);
  assert.equal(r.win, true);
});

test("black 3-3 is forbidden", () => {
  const r = judge(board({ black: [...row(7, [5, 6]), ...col(7, [5, 6])] }), at(7, 7), B, "renju", 10);
  assert.equal(r.ok, false);
  assert.equal(r.code, "33");
  assert.equal(r.reason, "흑 3·3 금수");
});

test("3-3 is fine for white and in free rule", () => {
  const stones = [...row(7, [5, 6]), ...col(7, [5, 6])];
  assert.equal(judge(board({ white: stones }), at(7, 7), W, "renju", 10).ok, true);
  assert.equal(judge(board({ black: stones }), at(7, 7), B, "free", 10).ok, true);
});

test("black 4-4 is forbidden", () => {
  const r = judge(board({ black: [...row(7, [4, 5, 6]), ...col(7, [4, 5, 6])] }), at(7, 7), B, "renju", 10);
  assert.equal(r.ok, false);
  assert.equal(r.code, "44");
  assert.equal(r.reason, "흑 4·4 금수");
});

test("black 4-4 on a single line is forbidden", () => {
  // B . B B [N] . B  -> two separate fours in one row
  const r = judge(board({ black: row(7, [3, 5, 6, 9]) }), at(7, 7), B, "renju", 10);
  assert.equal(r.ok, false);
  assert.equal(r.code, "44");
});

test("five beats a simultaneous 3-3", () => {
  const stones = [...row(7, [3, 4, 5, 6]), ...col(7, [5, 6]), [5, 5], [6, 6]];
  const r = judge(board({ black: stones }), at(7, 7), B, "renju", 10);
  assert.equal(r.ok, true);
  assert.equal(r.win, true);
});

test("a four plus a three is allowed (4-3)", () => {
  const r = judge(board({ black: [...row(7, [4, 5, 6]), ...col(7, [5, 6])] }), at(7, 7), B, "renju", 10);
  assert.equal(r.ok, true);
  assert.equal(r.win, false);
});

test("blocked three does not count toward 3-3", () => {
  const r = judge(
    board({ black: [...row(7, [5, 6]), ...col(7, [5, 6])], white: [[4, 7]] }),
    at(7, 7), B, "renju", 10,
  );
  assert.equal(r.ok, true);
});

// Horizontal three 5,6,7 is blocked on the left by white (3,7), so its only open-four
// point is (8,7). With (7,7) placed, (8,7) makes two fours (row 5-8 and column 8 rows 4-7),
// so it is a 4-4 point; the horizontal three is a false three and (7,7) is not 3-3 even
// though it looks like one together with the vertical three.
const falseThree = {
  black: [...row(7, [5, 6]), ...col(7, [5, 6]), ...col(8, [4, 5, 6])],
  white: [[3, 7]],
};

test("strict: a three whose open-four point is itself forbidden still counts (3-3)", () => {
  const b = board(falseThree);
  b[at(7, 7)] = B;
  assert.equal(judge(b, at(8, 7), B, "renju", 20).code, "44"); // the trap point
  b[at(7, 7)] = 0;
  const r = judge(b, at(7, 7), B, "renju", 20);
  assert.equal(r.ok, false, JSON.stringify(r));
  assert.equal(r.code, "33");
});

test("same shape without the trap is a real 3-3", () => {
  const r = judge(
    board({ black: [...row(7, [5, 6]), ...col(7, [5, 6])], white: [[3, 7]] }),
    at(7, 7), B, "renju", 20,
  );
  // left side blocked: horizontal is still an open three via (8,7) -> forbidden
  assert.equal(r.code, "33");
});

test("five at the board edge", () => {
  const r = judge(board({ black: row(0, [0, 1, 2, 3]) }), at(4, 0), B, "renju", 10);
  assert.equal(r.win, true);
  const d = judge(board({ white: [[14, 10], [13, 11], [12, 12], [11, 13]] }), at(10, 14), W, "renju", 10);
  assert.equal(d.win, true);
});

test("four in a row with no fifth point is not a win", () => {
  const r = judge(board({ black: row(7, [4, 5, 6]) }), at(7, 7), B, "renju", 10);
  assert.equal(r.ok, true);
  assert.equal(r.win, false);
});

test("occupied point is rejected", () => {
  const r = judge(board({ white: [[7, 7]] }), at(7, 7), B, "renju", 10);
  assert.equal(r.ok, false);
  assert.equal(r.code, "occupied");
});

test("renju first black stone must be the center", () => {
  const r = judge(board(), at(3, 3), B, "renju", 0);
  assert.equal(r.ok, false);
  assert.equal(r.code, "center");
  assert.equal(r.reason, "렌주룰: 흑 첫 수는 중앙");
  assert.equal(judge(board(), CENTER, B, "renju", 0).ok, true);
  assert.equal(judge(board(), at(3, 3), B, "free", 0).ok, true);
});

test("forbiddenPoints lists 3-3 and 4-4 points with reasons", () => {
  const pts = forbiddenPoints(board({ black: [...row(7, [5, 6]), ...col(7, [5, 6])] }));
  const p = pts.find((q) => q.idx === at(7, 7));
  assert.ok(p);
  assert.equal(p.code, "33");
  assert.equal(p.reason, "흑 3·3 금수");
  const strict = forbiddenPoints(board(falseThree));
  assert.equal(strict.find((q) => q.idx === at(7, 7))?.code, "33"); // looks like 3-3 -> forbidden
  assert.equal(strict.some((q) => q.idx === at(8, 7)), false); // (8,7) is only 4-4 once (7,7) is black
});

test("split three (X.XX) counts toward 3-3", () => {
  // row: (5,7) . (7,7)* (8,7) -> X.XX ; column: (7,5),(7,6)
  const r = judge(board({ black: [[5, 7], [8, 7], [7, 5], [7, 6]] }), at(7, 7), B, "renju", 10);
  assert.equal(r.code, "33");
});

test("diagonal + anti-diagonal 3-3", () => {
  const r = judge(board({ black: [[5, 5], [6, 6], [9, 5], [8, 6]] }), at(7, 7), B, "renju", 10);
  assert.equal(r.code, "33");
});

test("closed four + closed four is still 4-4", () => {
  const r = judge(
    board({ black: [...row(7, [4, 5, 6]), ...col(7, [4, 5, 6])], white: [[3, 7], [7, 3]] }),
    at(7, 7), B, "renju", 10,
  );
  assert.equal(r.code, "44");
});

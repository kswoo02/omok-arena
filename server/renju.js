// Omok / Renju move judge. Board: array of 225, 0 empty, 1 black, 2 white, idx = y*15 + x.
export const SIZE = 15;
export const CENTER = 7 * SIZE + 7;
export const BLACK = 1;
export const WHITE = 2;

const DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

export const REASONS = {
  occupied: "이미 돌이 있는 자리",
  invalid: "판 밖의 자리",
  center: "렌주룰: 흑 첫 수는 중앙",
  overline: "흑 장목(6목 이상) 금수",
  44: "흑 4·4 금수",
  33: "흑 3·3 금수",
};

const xy = (idx) => [idx % SIZE, Math.floor(idx / SIZE)];
const inside = (x, y) => x >= 0 && y >= 0 && x < SIZE && y < SIZE;

/** cell at offset k from idx along (dx,dy), or -1 if off the board */
function step(idx, dx, dy, k) {
  const [x, y] = xy(idx);
  const nx = x + dx * k;
  const ny = y + dy * k;
  return inside(nx, ny) ? ny * SIZE + nx : -1;
}

/** contiguous stones of `color` through idx along a direction (idx must hold color) */
function run(b, idx, color, dx, dy) {
  const cells = [idx];
  for (const s of [1, -1]) {
    for (let k = 1; ; k++) {
      const p = step(idx, dx * s, dy * s, k);
      if (p < 0 || b[p] !== color) break;
      cells.push(p);
    }
  }
  return cells;
}

/** offsets k along the line where one more black stone makes exactly five through idx */
function fivePoints(b, idx, dx, dy) {
  const pts = [];
  for (let k = -4; k <= 4; k++) {
    if (k === 0) continue;
    const p = step(idx, dx, dy, k);
    if (p < 0 || b[p] !== 0) continue;
    b[p] = BLACK;
    if (run(b, idx, BLACK, dx, dy).length === 5) pts.push(k);
    b[p] = 0;
  }
  return pts;
}

/** number of fours through idx in one direction (a straight open four counts once) */
function foursInDir(b, idx, dx, dy) {
  const pts = fivePoints(b, idx, dx, dy);
  if (pts.length === 0) return 0;
  if (pts.length === 2 && pts[1] - pts[0] === 5) return 1; // .XXXX. = one open four
  return Math.min(pts.length, 2);
}

function isOpenFour(b, idx, dx, dy) {
  const pts = fivePoints(b, idx, dx, dy);
  return pts.length === 2 && pts[1] - pts[0] === 5;
}

/** a direction holds an open three if one more stone there makes an open four.
 *  Strict rule (user decision): no "false three" exception — it counts even when that
 *  stone would itself be forbidden for black. */
function hasOpenThree(b, idx, dx, dy) {
  for (let k = -4; k <= 4; k++) {
    if (k === 0) continue;
    const p = step(idx, dx, dy, k);
    if (p < 0 || b[p] !== 0) continue;
    b[p] = BLACK;
    const open = isOpenFour(b, idx, dx, dy) && run(b, idx, BLACK, dx, dy).includes(p);
    b[p] = 0;
    if (open) return true;
  }
  return false;
}

/** black stone already placed at idx: forbidden code or null. Exact five is never forbidden. */
function forbiddenAt(b, idx) {
  let overline = false;
  for (const [dx, dy] of DIRS) {
    const n = run(b, idx, BLACK, dx, dy).length;
    if (n === 5) return null;
    if (n > 5) overline = true;
  }
  if (overline) return "overline";
  let fours = 0;
  const fourDirs = [];
  for (const [dx, dy] of DIRS) {
    const f = foursInDir(b, idx, dx, dy);
    fours += f;
    fourDirs.push(f > 0);
  }
  if (fours >= 2) return "44";
  let threes = 0;
  DIRS.forEach(([dx, dy], i) => {
    if (!fourDirs[i] && hasOpenThree(b, idx, dx, dy)) threes++;
  });
  return threes >= 2 ? "33" : null;
}

const fail = (code) => ({ ok: false, code, reason: REASONS[code] });

/**
 * Judge a move. moveNo = number of stones already on the board (0 = first move).
 * -> { ok: true, win, line } | { ok: false, code, reason }
 */
export function judge(board, idx, color, rule, moveNo) {
  if (!Number.isInteger(idx) || idx < 0 || idx >= SIZE * SIZE) return fail("invalid");
  if (board[idx] !== 0) return fail("occupied");
  const renjuBlack = rule === "renju" && color === BLACK;
  if (renjuBlack && moveNo === 0 && idx !== CENTER) return fail("center");
  const b = board.slice();
  b[idx] = color;
  for (const [dx, dy] of DIRS) {
    const cells = run(b, idx, color, dx, dy);
    if (renjuBlack ? cells.length === 5 : cells.length >= 5) {
      return { ok: true, win: true, line: cells.sort((a, c) => a - c) };
    }
  }
  if (renjuBlack) {
    const code = forbiddenAt(b, idx);
    if (code) return fail(code);
  }
  return { ok: true, win: false, line: null };
}

/** every empty point that is forbidden for black right now (renju) */
export function forbiddenPoints(board) {
  const b = board.slice();
  const out = [];
  for (let idx = 0; idx < b.length; idx++) {
    if (b[idx] !== 0) continue;
    b[idx] = BLACK;
    const code = forbiddenAt(b, idx);
    b[idx] = 0;
    if (code) out.push({ idx, code, reason: REASONS[code] });
  }
  return out;
}

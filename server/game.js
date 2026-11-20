// Room state transitions. Pure functions: each returns { room } (a new object) or { error }.
import { BLACK, WHITE, SIZE, judge, forbiddenPoints, REASONS } from "./renju.js";

const COLOR_NAME = { 1: "흑", 2: "백" };
const SEAT_OF = { 1: "black", 2: "white" };

export function cleanName(s, max = 12) {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

const err = (status, code, reason) => ({ error: { status, code, reason } });

function emptyBoard() {
  return new Array(SIZE * SIZE).fill(0);
}

function fresh(room) {
  return { ...room, board: emptyBoard(), moves: [], turn: BLACK, result: null, rematch: [] };
}

export function seatOf(room, playerId) {
  if (room.seats.black?.id === playerId) return "black";
  if (room.seats.white?.id === playerId) return "white";
  return null;
}

export function newRoom({ id, name, rule, player }) {
  const now = Date.now();
  return fresh({
    id,
    name: cleanName(name, 20) || `${player.name}의 방`,
    rule: rule === "free" ? "free" : "renju",
    seats: { black: { id: player.id, name: player.name }, white: null },
    status: "waiting",
    version: 0,
    createdAt: now,
    updatedAt: now,
  });
}

/** sit in a free seat (black first), or return the seat already held; null seat = spectator */
export function join(room, player) {
  const held = seatOf(room, player.id);
  if (held) {
    const seats = { ...room.seats, [held]: { id: player.id, name: player.name } };
    return { room: { ...room, seats }, seat: held };
  }
  const seat = !room.seats.black ? "black" : !room.seats.white ? "white" : null;
  if (!seat) return { room, seat: null };
  let next = { ...room, seats: { ...room.seats, [seat]: { id: player.id, name: player.name } } };
  if (next.seats.black && next.seats.white && next.status !== "playing") {
    next = { ...fresh(next), status: "playing" };
  }
  return { room: next, seat };
}

export function move(room, playerId, idx) {
  const seat = seatOf(room, playerId);
  if (!seat) return err(403, "seat", "대국자만 둘 수 있어요");
  if (room.status === "ended") return err(409, "ended", "대국이 끝났어요");
  if (room.status !== "playing") return err(409, "waiting", "상대를 기다리는 중이에요");
  const color = seat === "black" ? BLACK : WHITE;
  if (room.turn !== color) return err(409, "turn", "상대 차례예요");
  const r = judge(room.board, idx, color, room.rule, room.moves.length);
  if (!r.ok) return err(r.code === "invalid" ? 400 : 409, r.code, r.reason);
  const board = room.board.slice();
  board[idx] = color;
  const moves = [...room.moves, idx];
  if (r.win) {
    return {
      room: { ...room, board, moves, status: "ended",
        result: { winner: color, reason: `${COLOR_NAME[color]} 5목 승리`, line: r.line } },
    };
  }
  if (moves.length === SIZE * SIZE) {
    return { room: { ...room, board, moves, status: "ended", result: { winner: null, reason: "무승부", line: null } } };
  }
  return { room: { ...room, board, moves, turn: color === BLACK ? WHITE : BLACK } };
}

export function resign(room, playerId) {
  const seat = seatOf(room, playerId);
  if (!seat) return err(403, "seat", "대국자만 기권할 수 있어요");
  if (room.status !== "playing") return err(409, "not_playing", "진행 중인 대국이 없어요");
  const color = seat === "black" ? BLACK : WHITE;
  const winner = color === BLACK ? WHITE : BLACK;
  return { room: { ...room, status: "ended", result: { winner, reason: `${COLOR_NAME[color]} 기권`, line: null } } };
}

/** give up the seat; during play this is a resign first */
export function leave(room, playerId) {
  const seat = seatOf(room, playerId);
  if (!seat) return { room };
  let next = room;
  if (room.status === "playing") next = resign(room, playerId).room;
  next = { ...next, seats: { ...next.seats, [seat]: null }, rematch: [] };
  if (next.status === "ended" || !next.seats.black || !next.seats.white) {
    next = { ...next, status: "waiting" };
  }
  // keep the finished board visible to whoever stays; a new game starts on the next join
  return { room: next };
}

export function rematch(room, playerId) {
  if (!seatOf(room, playerId)) return err(403, "seat", "대국자만 요청할 수 있어요");
  if (room.status !== "ended") return err(409, "not_ended", "대국이 끝난 뒤에 요청할 수 있어요");
  const want = room.rematch.includes(playerId) ? room.rematch : [...room.rematch, playerId];
  if (want.length < 2) return { room: { ...room, rematch: want } };
  const seats = { black: room.seats.white, white: room.seats.black }; // swap colors
  return { room: { ...fresh({ ...room, seats }), status: "playing" } };
}

/** what a browser may see; never contains player tokens */
export function view(room, playerId) {
  const seatName = (s) => (s ? { name: s.name } : null);
  const blackToMove = room.status === "playing" && room.turn === BLACK;
  return {
    id: room.id,
    name: room.name,
    rule: room.rule,
    version: room.version,
    status: room.status,
    seats: { black: seatName(room.seats.black), white: seatName(room.seats.white) },
    me: seatOf(room, playerId),
    board: room.board,
    moveCount: room.moves.length,
    lastMove: room.moves.at(-1) ?? null,
    turn: room.turn,
    result: room.result,
    rematch: { count: room.rematch.length, mine: room.rematch.includes(playerId) },
    forbidden: room.rule === "renju" && blackToMove && room.moves.length > 0 ? forbiddenPoints(room.board) : [],
    centerOnly: room.rule === "renju" && blackToMove && room.moves.length === 0,
  };
}

export function summary(room) {
  return {
    id: room.id,
    name: room.name,
    rule: room.rule,
    status: room.status,
    players: (room.seats.black ? 1 : 0) + (room.seats.white ? 1 : 0),
    names: [room.seats.black?.name, room.seats.white?.name].filter(Boolean),
    updatedAt: room.updatedAt,
  };
}

export { SEAT_OF, REASONS };

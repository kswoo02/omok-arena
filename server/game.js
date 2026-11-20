// Room state transitions. Pure functions: each returns { room } (a new object) or { error }.
import { BLACK, WHITE, SIZE, judge, forbiddenPoints, REASONS } from "./renju.js";

const COLOR_NAME = { 1: "흑", 2: "백" };
const SEAT_OF = { 1: "black", 2: "white" };
export const EMOJIS = ["👍", "😮", "😂", "😭", "🔥", "👏"];
export const TIME_LIMITS = [0, 30, 60];
export const ONLINE_MS = 45_000; // seen within this window = online
const REACT_GAP_MS = 2_000;

export function cleanName(s, max = 12) {
  return String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

const err = (status, code, reason) => ({ error: { status, code, reason } });

function fresh(room) {
  return {
    ...room,
    board: new Array(SIZE * SIZE).fill(0),
    moves: [],
    turn: BLACK,
    result: null,
    rematch: [],
    deadline: null,
  };
}

function start(room, now) {
  return { ...fresh(room), status: "playing", deadline: room.timeLimit ? now + room.timeLimit * 1000 : null };
}

export function seatOf(room, playerId) {
  if (room.seats.black?.id === playerId) return "black";
  if (room.seats.white?.id === playerId) return "white";
  return null;
}

export function newRoom({ id, name, rule, player, private: priv = false, timeLimit = 0, now = Date.now() }) {
  return fresh({
    id,
    name: cleanName(name, 20) || `${player.name}의 방`,
    rule: rule === "free" ? "free" : "renju",
    private: !!priv,
    timeLimit: TIME_LIMITS.includes(Number(timeLimit)) ? Number(timeLimit) : 0,
    seats: { black: { id: player.id, name: player.name }, white: null },
    ownerId: player.id,
    kicked: [],
    status: "waiting",
    reaction: null,
    reactAt: {},
    rematchDeclined: 0,
    version: 0,
    createdAt: now,
    updatedAt: now,
  });
}

/** sit in a free seat (black first), or return the seat already held; null seat = spectator */
export function join(room, player, now = Date.now()) {
  const held = seatOf(room, player.id);
  if (held) {
    const seats = { ...room.seats, [held]: { id: player.id, name: player.name } };
    return { room: { ...room, seats }, seat: held };
  }
  if ((room.kicked ?? []).includes(player.id)) return { room, seat: null };
  const seat = !room.seats.black ? "black" : !room.seats.white ? "white" : null;
  if (!seat) return { room, seat: null };
  let next = { ...room, seats: { ...room.seats, [seat]: { id: player.id, name: player.name } } };
  if (!next.ownerId) next.ownerId = player.id;
  if (next.seats.black && next.seats.white && next.status !== "playing") next = start(next, now);
  return { room: next, seat };
}

/** time ran out on the current turn: the player to move loses. null if nothing changes. */
export function settle(room, now = Date.now()) {
  if (room.status !== "playing" || !room.deadline || now <= room.deadline) return null;
  const loser = room.turn;
  return {
    ...room,
    status: "ended",
    deadline: null,
    result: { winner: loser === BLACK ? WHITE : BLACK, reason: `${COLOR_NAME[loser]} 시간 초과`, line: null },
  };
}

export function move(room, playerId, idx, now = Date.now()) {
  const seat = seatOf(room, playerId);
  if (!seat) return err(403, "seat", "대국자만 둘 수 있어요");
  if (room.status === "ended") return err(409, "ended", "대국이 끝났어요");
  if (room.status !== "playing") return err(409, "waiting", "상대를 기다리는 중이에요");
  if (room.deadline && now > room.deadline) return err(409, "timeout", "시간이 초과됐어요");
  const color = seat === "black" ? BLACK : WHITE;
  if (room.turn !== color) return err(409, "turn", "상대 차례예요");
  const r = judge(room.board, idx, color, room.rule, room.moves.length);
  if (!r.ok) return err(r.code === "invalid" ? 400 : 409, r.code, r.reason);
  const board = room.board.slice();
  board[idx] = color;
  const moves = [...room.moves, idx];
  if (r.win) {
    return {
      room: { ...room, board, moves, status: "ended", deadline: null,
        result: { winner: color, reason: `${COLOR_NAME[color]} 5목 승리`, line: r.line } },
    };
  }
  if (moves.length === SIZE * SIZE) {
    return { room: { ...room, board, moves, status: "ended", deadline: null, result: { winner: null, reason: "무승부", line: null } } };
  }
  return {
    room: { ...room, board, moves, turn: color === BLACK ? WHITE : BLACK,
      deadline: room.timeLimit ? now + room.timeLimit * 1000 : null },
  };
}

export function resign(room, playerId) {
  const seat = seatOf(room, playerId);
  if (!seat) return err(403, "seat", "대국자만 기권할 수 있어요");
  if (room.status !== "playing") return err(409, "not_playing", "진행 중인 대국이 없어요");
  const color = seat === "black" ? BLACK : WHITE;
  const winner = color === BLACK ? WHITE : BLACK;
  return { room: { ...room, status: "ended", deadline: null, result: { winner, reason: `${COLOR_NAME[color]} 기권`, line: null } } };
}

function vacate(room, seat) {
  const leaving = room.seats[seat]?.id;
  let next = room.status === "playing" ? resign(room, leaving).room : room;
  next = { ...next, seats: { ...next.seats, [seat]: null }, rematch: [] };
  if (next.status === "ended" || !next.seats.black || !next.seats.white) next = { ...next, status: "waiting" };
  if (next.ownerId === leaving) next.ownerId = next.seats.black?.id ?? next.seats.white?.id ?? null;
  return next;
}

/** give up the seat; during play this is a resign first */
export function leave(room, playerId) {
  const seat = seatOf(room, playerId);
  if (!seat) return { room };
  // keep the finished board visible to whoever stays; a new game starts on the next join
  return { room: vacate(room, seat) };
}

/** owner removes the opponent; during play only when the opponent has been away ONLINE_MS */
export function kick(room, byId, seen = {}, now = Date.now()) {
  if (room.ownerId !== byId || !seatOf(room, byId)) return err(403, "owner", "방장만 내보낼 수 있어요");
  const seat = seatOf(room, byId) === "black" ? "white" : "black";
  const target = room.seats[seat];
  if (!target) return err(409, "no_target", "내보낼 상대가 없어요");
  const lastSeen = seen[target.id]?.at ?? 0;
  if (room.status === "playing" && now - lastSeen < ONLINE_MS) {
    return err(409, "online", "상대가 접속 중이에요. 자리를 비운 지 45초가 지나야 내보낼 수 있어요.");
  }
  const next = vacate(room, seat);
  return { room: { ...next, kicked: [...new Set([...(room.kicked ?? []), target.id])] } };
}

export function rematch(room, playerId, now = Date.now()) {
  if (!seatOf(room, playerId)) return err(403, "seat", "대국자만 요청할 수 있어요");
  if (room.status !== "ended") return err(409, "not_ended", "대국이 끝난 뒤에 요청할 수 있어요");
  const want = room.rematch.includes(playerId) ? room.rematch : [...room.rematch, playerId];
  if (want.length < 2) return { room: { ...room, rematch: want } };
  const seats = { black: room.seats.white, white: room.seats.black }; // swap colors
  return { room: start({ ...room, seats }, now) };
}

export function declineRematch(room, playerId) {
  if (!seatOf(room, playerId)) return err(403, "seat", "대국자만 거절할 수 있어요");
  const other = room.rematch.filter((id) => id !== playerId);
  if (room.status !== "ended" || other.length === 0) return err(409, "no_request", "받은 재대결 요청이 없어요");
  return { room: { ...room, rematch: [], rematchDeclined: (room.rematchDeclined ?? 0) + 1 } };
}

export function react(room, player, emoji, now = Date.now()) {
  if (!EMOJIS.includes(emoji)) return err(400, "emoji", "보낼 수 없는 이모티콘이에요");
  const last = room.reactAt?.[player.id] ?? 0;
  if (now - last < REACT_GAP_MS) return err(429, "slow", "잠시 뒤에 다시 보내 주세요");
  const reactAt = Object.fromEntries(Object.entries(room.reactAt ?? {}).filter(([, t]) => now - t < 10_000));
  reactAt[player.id] = now;
  const reaction = { seq: (room.reaction?.seq ?? 0) + 1, emoji, name: player.name, seat: seatOf(room, player.id), at: now };
  return { room: { ...room, reaction, reactAt } };
}

/**
 * what a browser may see; never contains player tokens.
 * seen: { playerId: { name, at } } from presence; now: server time.
 */
export function view(room, playerId, { seen = null, now = Date.now() } = {}) {
  const online = (s) => (seen && s ? now - (seen[s.id]?.at ?? 0) < ONLINE_MS : null);
  const seatView = (s) => (s ? { name: s.name, online: online(s) } : null);
  const blackToMove = room.status === "playing" && room.turn === BLACK;
  const seatedIds = [room.seats.black?.id, room.seats.white?.id];
  const spectators = seen
    ? Object.entries(seen)
        .filter(([id, p]) => !seatedIds.includes(id) && now - p.at < ONLINE_MS)
        .map(([, p]) => p.name)
    : [];
  const mine = room.rematch.includes(playerId);
  return {
    id: room.id,
    name: room.name,
    rule: room.rule,
    private: !!room.private,
    timeLimit: room.timeLimit ?? 0,
    deadline: room.deadline ?? null,
    serverNow: now,
    version: room.version,
    status: room.status,
    seats: { black: seatView(room.seats.black), white: seatView(room.seats.white) },
    me: seatOf(room, playerId),
    owner: !!playerId && room.ownerId === playerId,
    board: room.board,
    moveCount: room.moves.length,
    lastMove: room.moves.at(-1) ?? null,
    turn: room.turn,
    result: room.result,
    rematch: { count: room.rematch.length, mine, fromOther: room.rematch.length > 0 && !mine, declined: room.rematchDeclined ?? 0 },
    reaction: room.reaction ?? null,
    spectators,
    forbidden: room.rule === "renju" && blackToMove && room.moves.length > 0 ? forbiddenPoints(room.board) : [],
    centerOnly: room.rule === "renju" && blackToMove && room.moves.length === 0,
  };
}

export function summary(room) {
  return {
    id: room.id,
    name: room.name,
    rule: room.rule,
    private: !!room.private,
    timeLimit: room.timeLimit ?? 0,
    status: room.status,
    players: (room.seats.black ? 1 : 0) + (room.seats.white ? 1 : 0),
    names: [room.seats.black?.name, room.seats.white?.name].filter(Boolean),
    updatedAt: room.updatedAt,
  };
}

export { SEAT_OF, REASONS };

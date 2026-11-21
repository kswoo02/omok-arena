// HTTP routing shared by the Vercel function (api/index.js) and dev-server.js.
import { randomBytes } from "node:crypto";
import { logEvent } from "./admin.js";
import { abandoned, canSee, cleanName, declineRematch, join, kick, leave, move, newRoom, react, rematch, resign, seatOf, settle, view } from "./game.js";

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const ROOM_RE = /^[a-z0-9]{6,12}$/;
const res = (status, json) => ({ status, json });
const bad = (code, reason, status = 400) => res(status, { error: { code, reason } });

export const newRoomId = () => randomBytes(6).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").padEnd(8, "0").slice(0, 8);

/** log the action and any game start/end it caused (admin page) */
async function record(store, log, playerId, before, after, error) {
  if (!log?.ctx) return;
  const nameOf = (r) => r && (r.seats.black?.id === playerId ? r.seats.black.name : r.seats.white?.id === playerId ? r.seats.white.name : null);
  const name = nameOf(after) ?? nameOf(before) ?? log.name ?? "";
  const room = before?.id;
  if (error) {
    if (log.fail) await logEvent(store, log.ctx, log.fail, { room, name, reason: error.reason });
    return;
  }
  const type = typeof log.type === "function" ? log.type(before) : log.type;
  if (type) await logEvent(store, log.ctx, type, { room, name, ...(log.extra?.(after) ?? {}) });
  const names = after ? [after.seats.black?.name, after.seats.white?.name].filter(Boolean).join(" vs ") : "";
  if (before?.status !== "playing" && after?.status === "playing") await logEvent(store, log.ctx, "game_start", { room, name: names });
  if (before?.status !== "ended" && after?.status === "ended" && after.result) {
    await logEvent(store, log.ctx, "game_end", { room, name: names, reason: after.result.reason });
  }
}

/** apply fn to the stored room with compare-and-set, retrying on races.
 *  A run-out clock is settled first, so every action sees the timeout. */
async function mutate(store, id, playerId, fn, log = null) {
  for (let i = 0; i < 6; i++) {
    const now = Date.now();
    // room and presence in parallel: one round trip to Redis instead of two
    const [stored, seen] = await Promise.all([store.get(id), store.seen(id)]);
    if (!stored) return bad("not_found", "방이 없어요. 시간이 지나 사라졌을 수 있어요.", 404);
    if (!log?.join && !canSee(stored, playerId)) return locked(stored); // secret room, not let in
    const settled = settle(stored, now);
    const cur = settled ?? stored;
    const out = fn(cur, seen, now);
    let next = out.error ? cur : out.room;
    if (next === stored) {
      await record(store, log, playerId, stored, stored, out.error);
      if (out.error) return res(out.error.status, { error: { code: out.error.code, reason: out.error.reason } });
      return res(200, { room: view(stored, playerId, { seen, now }), seat: out.seat ?? null });
    }
    next = { ...next, version: stored.version + 1, updatedAt: now };
    if (!(await store.put(next, stored.version))) continue;
    await record(store, log, playerId, stored, next, out.error);
    if (out.error) return res(out.error.status, { error: { code: out.error.code, reason: out.error.reason } });
    return res(200, { room: view(next, playerId, { seen, now }), seat: out.seat ?? null });
  }
  return bad("busy", "동시에 요청이 몰렸어요. 다시 시도해 주세요.", 503);
}

/**
 * route({ method, path, query, body }, store) -> { status, json }
 * path is like "/api/rooms/abc123/move"
 */
export async function route({ method, path, query = {}, body = {}, ip, ua, region }, store) {
  const ctx = ip ? { ip, ua, region } : null; // null in unit tests that call route directly
  const parts = path.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  if (parts[0] !== "rooms") return bad("not_found", "없는 주소예요", 404);
  const playerId = String(body.playerId ?? query.playerId ?? "");
  const needPlayer = () => (ID_RE.test(playerId) ? null : bad("player", "잘못된 사용자 정보예요"));
  const needName = () => {
    const name = cleanName(body.nickname);
    return name ? { id: playerId, name } : null;
  };

  // /api/rooms
  if (parts.length === 1) {
    if (method === "GET") return res(200, { rooms: await store.list() });
    if (method === "POST") {
      const e = needPlayer();
      if (e) return e;
      const player = needName();
      if (!player) return bad("nickname", "닉네임을 입력해 주세요");
      const password = typeof body.password === "string" ? body.password : "";
      if (password && (password.length < 4 || password.length > 20)) return bad("password_rule", "비밀번호는 4~20자로 정해 주세요");
      for (let i = 0; i < 5; i++) {
        const room = {
          ...newRoom({ id: newRoomId(), name: body.name, rule: body.rule, player,
            password, timeLimit: Number(body.timeLimit) || 0 }),
          version: 1,
        };
        if (await store.put(room, 0)) {
          await store.touch(room.id, playerId, { name: player.name, at: Date.now() });
          await store.markLive(room.id, Date.now());
          await logEvent(store, ctx, "create", { room: room.id, name: player.name,
            reason: `${room.rule === "renju" ? "렌주" : "자유"}${room.timeLimit ? `, ${room.timeLimit}초` : ""}${room.pwHash ? ", 비밀방" : ""}` });
          return res(201, { room: view(room, playerId), seat: "black" });
        }
      }
      return bad("busy", "방을 만들지 못했어요. 다시 시도해 주세요.", 503);
    }
    return bad("method", "지원하지 않는 요청이에요", 405);
  }

  const id = parts[1];
  if (!ROOM_RE.test(id)) return bad("not_found", "방이 없어요", 404);
  const action = parts[2];

  if (!action && method === "GET") {
    const room = await store.get(id);
    if (!room) return bad("not_found", "방이 없어요. 시간이 지나 사라졌을 수 있어요.", 404);
    if (!canSee(room, playerId)) return locked(room);
    if (settle(room, Date.now())) return mutate(store, id, playerId, (r) => ({ room: r }));
    return res(200, { room: view(room, playerId, { seen: await store.seen(id) }) });
  }
  if (method !== "POST") return bad("method", "지원하지 않는 요청이에요", 405);
  const e = needPlayer();
  if (e) return e;

  switch (action) {
    case "join": {
      const player = needName();
      if (!player) return bad("nickname", "닉네임을 입력해 주세요");
      const password = typeof body.password === "string" ? body.password : undefined;
      const out = await mutate(store, id, playerId, (r, seen, now) =>
        !seatOf(r, playerId) && abandoned(r, seen, now)
          ? { error: { status: 410, code: "closed", reason: "방장이 오래 자리를 비워 닫힌 방이에요. 로비에서 다른 방을 찾아 주세요." } }
          : join(r, player, now, { password }),
        { ctx, join: true, type: (before) => (seatOf(before, playerId) ? "rejoin" : "join"), fail: "join_fail", name: player.name,
          extra: (r) => ({ reason: seatOf(r, playerId) ? (seatOf(r, playerId) === "black" ? "흑 자리" : "백 자리") : "관전" }) });
      // only people who got in count as present (a wrong password must not appear as a spectator)
      if (out.status === 200) {
        await store.touch(id, playerId, { name: player.name, at: Date.now() });
        if (out.json.seat) await store.markLive(id, Date.now());
      }
      return out;
    }
    case "move": {
      const idx = typeof body.idx === "number" ? body.idx : NaN;
      return mutate(store, id, playerId, (r, _s, now) => move(r, playerId, Number.isInteger(idx) ? idx : -1, now), { ctx });
    }
    case "ping": {
      const name = cleanName(body.nickname) || "손님";
      const room = await store.get(id);
      if (!room) return bad("not_found", "방이 없어요", 404);
      if (!canSee(room, playerId)) return locked(room);
      await store.touch(id, playerId, { name, at: Date.now() });
      if (seatOf(room, playerId)) await store.markLive(id, Date.now());
      return res(200, { ok: true });
    }
    case "react": {
      const player = needName() ?? { id: playerId, name: "손님" };
      return mutate(store, id, playerId, (r, _s, now) => react(r, player, String(body.emoji ?? ""), now));
    }
    case "decline":
      return mutate(store, id, playerId, (r) => declineRematch(r, playerId), { ctx, type: "rematch_decline" });
    case "kick":
      return mutate(store, id, playerId, (r, seen, now) => kick(r, playerId, seen, now), { ctx, type: "kick" });
    case "resign":
      return mutate(store, id, playerId, (r) => resign(r, playerId), { ctx, type: "resign" });
    case "leave": {
      const out = await mutate(store, id, playerId, (r) => leave(r, playerId), { ctx, type: "leave" });
      const room = out.status === 200 ? await store.get(id) : null;
      if (room && !room.seats.black && !room.seats.white) await store.remove(id); // last one out closes the room
      return out;
    }
    case "rematch":
      return mutate(store, id, playerId, (r, _s, now) => rematch(r, playerId, now), { ctx, type: "rematch" });
    default:
      return bad("not_found", "없는 주소예요", 404);
  }
}

/** secret room seen by someone not let in: name and rule only */
function locked(room) {
  return res(403, { error: { code: "password", reason: "비밀방이에요. 비밀번호를 입력해 주세요",
    room: { name: room.name, rule: room.rule, locked: true } } });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Server-sent events for one room: `room` whenever the version changes, `presence` when the
 * set of people online changes (checked every ~5 s), `gone` if the room disappears.
 * Also settles a run-out clock. Ends after `duration` ms; EventSource reconnects by itself.
 */
export async function stream({ id, playerId, since = -1 }, store, write, isClosed, { interval = 1000, duration = 25000 } = {}) {
  write("retry: 1000\n\n");
  const end = Date.now() + duration;
  let last = Number.isFinite(since) ? since : -1;
  let ping = Date.now();
  let deadline = null;
  let presenceKey = "";
  const first = await store.get(id);
  if (first && !canSee(first, playerId)) {
    write(`event: locked\ndata: {}\n\n`);
    return;
  }
  for (let tick = 0; !isClosed() && Date.now() < end; tick++) {
    const now = Date.now();
    if (deadline && now > deadline + 300) {
      deadline = null;
      await mutate(store, id, playerId, (r) => ({ room: r })); // writes the timeout if still due
    }
    const v = await store.version(id);
    if (v === 0) {
      write(`event: gone\ndata: {}\n\n`);
      return;
    }
    const sendPresence = tick % 5 === 0;
    if (v !== last || sendPresence) {
      const [room, seen] = await Promise.all([store.get(id), store.seen(id)]);
      if (!room) {
        await sleep(interval);
        continue;
      }
      const vw = view(room, playerId, { seen, now: Date.now() });
      deadline = vw.status === "playing" ? vw.deadline : null;
      if (room.version !== last) {
        last = room.version;
        write(`event: room\ndata: ${JSON.stringify(vw)}\n\n`);
      }
      const p = { spectators: vw.spectators, online: { black: vw.seats.black?.online ?? null, white: vw.seats.white?.online ?? null } };
      const key = JSON.stringify(p);
      if (key !== presenceKey) {
        presenceKey = key;
        write(`event: presence\ndata: ${key}\n\n`);
      }
      ping = Date.now();
    } else if (Date.now() - ping > 10000) {
      write(`: ping\n\n`);
      ping = Date.now();
    }
    await sleep(interval);
  }
}

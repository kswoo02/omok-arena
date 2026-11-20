// HTTP routing shared by the Vercel function (api/index.js) and dev-server.js.
import { randomBytes } from "node:crypto";
import { cleanName, join, leave, move, newRoom, rematch, resign, view } from "./game.js";

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const ROOM_RE = /^[a-z0-9]{6,12}$/;
const res = (status, json) => ({ status, json });
const bad = (code, reason, status = 400) => res(status, { error: { code, reason } });

export const newRoomId = () => randomBytes(6).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").padEnd(8, "0").slice(0, 8);

/** apply fn to the stored room with compare-and-set, retrying on races */
async function mutate(store, id, playerId, fn) {
  for (let i = 0; i < 6; i++) {
    const cur = await store.get(id);
    if (!cur) return bad("not_found", "방이 없어요. 시간이 지나 사라졌을 수 있어요.", 404);
    const out = fn(cur);
    if (out.error) return res(out.error.status, { error: { code: out.error.code, reason: out.error.reason } });
    if (out.room === cur) return res(200, { room: view(cur, playerId), seat: out.seat ?? null });
    const next = { ...out.room, version: cur.version + 1, updatedAt: Date.now() };
    if (await store.put(next, cur.version)) return res(200, { room: view(next, playerId), seat: out.seat ?? null });
  }
  return bad("busy", "동시에 요청이 몰렸어요. 다시 시도해 주세요.", 503);
}

/**
 * route({ method, path, query, body }, store) -> { status, json }
 * path is like "/api/rooms/abc123/move"
 */
export async function route({ method, path, query = {}, body = {} }, store) {
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
      for (let i = 0; i < 5; i++) {
        const room = { ...newRoom({ id: newRoomId(), name: body.name, rule: body.rule, player }), version: 1 };
        if (await store.put(room, 0)) return res(201, { room: view(room, playerId), seat: "black" });
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
    return room ? res(200, { room: view(room, playerId) }) : bad("not_found", "방이 없어요. 시간이 지나 사라졌을 수 있어요.", 404);
  }
  if (method !== "POST") return bad("method", "지원하지 않는 요청이에요", 405);
  const e = needPlayer();
  if (e) return e;

  switch (action) {
    case "join": {
      const player = needName();
      if (!player) return bad("nickname", "닉네임을 입력해 주세요");
      return mutate(store, id, playerId, (r) => join(r, player));
    }
    case "move": {
      const idx = typeof body.idx === "number" ? body.idx : NaN;
      return mutate(store, id, playerId, (r) => move(r, playerId, Number.isInteger(idx) ? idx : -1));
    }
    case "resign":
      return mutate(store, id, playerId, (r) => resign(r, playerId));
    case "leave":
      return mutate(store, id, playerId, (r) => leave(r, playerId));
    case "rematch":
      return mutate(store, id, playerId, (r) => rematch(r, playerId));
    default:
      return bad("not_found", "없는 주소예요", 404);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Server-sent events for one room: sends `room` whenever the version changes, `gone` if it
 * disappears. Ends after `duration` ms; the browser's EventSource reconnects by itself.
 */
export async function stream({ id, playerId, since = -1 }, store, write, isClosed, { interval = 1000, duration = 25000 } = {}) {
  write("retry: 1000\n\n");
  const end = Date.now() + duration;
  let last = Number.isFinite(since) ? since : -1;
  let ping = Date.now();
  while (!isClosed() && Date.now() < end) {
    const v = await store.version(id);
    if (v === 0) {
      write(`event: gone\ndata: {}\n\n`);
      return;
    }
    if (v !== last) {
      const room = await store.get(id);
      if (room) {
        last = room.version;
        write(`event: room\ndata: ${JSON.stringify(view(room, playerId))}\n\n`);
      }
    } else if (Date.now() - ping > 10000) {
      write(`: ping\n\n`);
      ping = Date.now();
    }
    await sleep(interval);
  }
}

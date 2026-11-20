// Room storage with compare-and-set on `version`. Memory (local/tests) or Upstash Redis.
import { summary } from "./game.js";

export const TTL_SEC = 2 * 60 * 60; // rooms vanish 2 h after the last change

export function memoryStore() {
  const rooms = new Map(); // id -> { json, expires }
  const presence = new Map(); // id -> { playerId: { name, at } }
  const alive = (id) => {
    const e = rooms.get(id);
    if (e && e.expires < Date.now()) rooms.delete(id);
    return rooms.get(id);
  };
  return {
    async get(id) {
      const e = alive(id);
      return e ? JSON.parse(e.json) : null;
    },
    async version(id) {
      const e = alive(id);
      return e ? JSON.parse(e.json).version : 0;
    },
    async put(room, expected) {
      const cur = alive(room.id);
      const v = cur ? JSON.parse(cur.json).version : 0;
      if (v !== expected) return false;
      rooms.set(room.id, { json: JSON.stringify(room), expires: Date.now() + TTL_SEC * 1000 });
      return true;
    },
    async list() {
      return [...rooms.keys()]
        .map((id) => alive(id))
        .filter(Boolean)
        .map((e) => summary(JSON.parse(e.json)))
        .filter((s) => s.players > 0 )
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 50);
    },
    async touch(id, playerId, info) {
      const m = presence.get(id) ?? {};
      m[playerId] = info;
      presence.set(id, m);
    },
    async seen(id) {
      return { ...(presence.get(id) ?? {}) };
    },
  };
}

const CAS = `
local cur = redis.call('GET', KEYS[2])
if (cur or '0') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[4])
redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
redis.call('ZADD', KEYS[3], ARGV[5], ARGV[6])
return 1`;

/** redis: an @upstash/redis client */
export function redisStore(redis) {
  const rk = (id) => `omok:room:${id}`;
  const vk = (id) => `omok:room:${id}:v`;
  const LIST = "omok:rooms";
  const pk = (id) => `omok:room:${id}:seen`;
  const parse = (v) => (v == null ? null : typeof v === "string" ? JSON.parse(v) : v);
  return {
    async get(id) {
      return parse(await redis.get(rk(id)));
    },
    async version(id) {
      return Number((await redis.get(vk(id))) ?? 0);
    },
    async put(room, expected) {
      const ok = await redis.eval(CAS, [rk(room.id), vk(room.id), LIST], [
        String(expected), JSON.stringify(room), String(room.version), String(TTL_SEC),
        String(room.updatedAt), room.id,
      ]);
      return Number(ok) === 1;
    },
    async list() {
      await redis.zremrangebyscore(LIST, 0, Date.now() - TTL_SEC * 1000);
      const ids = await redis.zrange(LIST, 0, 49, { rev: true });
      if (!ids.length) return [];
      const rooms = await redis.mget(...ids.map(rk));
      return rooms.map(parse).filter(Boolean).map(summary).filter((s) => s.players > 0 );
    },
    async touch(id, playerId, info) {
      await redis.hset(pk(id), { [playerId]: JSON.stringify(info) });
      await redis.expire(pk(id), 600);
    },
    async seen(id) {
      const h = (await redis.hgetall(pk(id))) ?? {};
      const out = {};
      const cutoff = Date.now() - 120_000;
      for (const [k, v] of Object.entries(h)) {
        const p = parse(v);
        if (p && p.at > cutoff) out[k] = p;
      }
      return out;
    },
  };
}

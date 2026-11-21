// Room storage with compare-and-set on `version`. Memory (local/tests) or Upstash Redis.
import { randomBytes } from "node:crypto";
import { summary } from "./game.js";

export const LOG_KEEP_MS = 7 * 86_400_000;
const LOG_MAX = 5000;

export const TTL_SEC = 2 * 60 * 60; // rooms vanish 2 h after the last change
export const LIST_LIVE_MS = 2 * 60_000; // lobby shows rooms with a seated player seen this recently

export function memoryStore() {
  const rooms = new Map(); // id -> { json, expires }
  const presence = new Map(); // id -> { playerId: { name, at } }
  const live = new Map(); // id -> last time a seated player was seen
  const watchers = new Map(); // id -> Set<fn>
  const notify = (id) => (watchers.get(id) ?? new Set()).forEach((fn) => fn());
  let logs = [];
  const banned = new Map();
  const fails = new Map(); // ip -> { n, until }
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
      notify(room.id);
      return true;
    },
    /** call fn whenever the room changes or is removed; returns an async stop() */
    async watch(id, fn) {
      if (!watchers.has(id)) watchers.set(id, new Set());
      watchers.get(id).add(fn);
      return async () => watchers.get(id)?.delete(fn);
    },
    async list() {
      return [...rooms.keys()]
        .map((id) => alive(id))
        .filter(Boolean)
        .map((e) => summary(JSON.parse(e.json)))
        .filter((s) => s.players > 0 && Date.now() - (live.get(s.id) ?? 0) < LIST_LIVE_MS)
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
    async markLive(id, at) {
      live.set(id, at);
    },
    async remove(id) {
      rooms.delete(id);
      presence.delete(id);
      live.delete(id);
      notify(id);
    },
    async allRooms() {
      return [...rooms.keys()].map((id) => alive(id)).filter(Boolean)
        .map((e) => ({ ...summary(JSON.parse(e.json)), liveAt: live.get(JSON.parse(e.json).id) ?? null }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },
    async addLog(entry) {
      logs.push(entry);
      const cutoff = Date.now() - LOG_KEEP_MS;
      logs = logs.filter((l) => l.at >= cutoff).slice(-LOG_MAX);
    },
    async logs() {
      const cutoff = Date.now() - LOG_KEEP_MS;
      return logs.filter((l) => l.at >= cutoff).slice().reverse();
    },
    async ban(ip, info) {
      banned.set(ip, info);
    },
    async unban(ip) {
      banned.delete(ip);
    },
    async bans() {
      return Object.fromEntries(banned);
    },
    async isBanned(ip) {
      return banned.has(ip);
    },
    async adminFail(ip) {
      const f = fails.get(ip);
      const now = Date.now();
      fails.set(ip, f && f.until > now ? { n: f.n + 1, until: f.until } : { n: 1, until: now + 900_000 });
    },
    async adminFails(ip) {
      const f = fails.get(ip);
      return f && f.until > Date.now() ? f.n : 0;
    },
  };
}

const CAS = `
local cur = redis.call('GET', KEYS[2])
if (cur or '0') ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[4])
redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])
redis.call('ZADD', KEYS[3], ARGV[5], ARGV[6])
redis.call('PUBLISH', 'omok:ch:' .. ARGV[6], ARGV[3])
return 1`;

/** redis: an @upstash/redis client */
export function redisStore(redis) {
  const rk = (id) => `omok:room:${id}`;
  const vk = (id) => `omok:room:${id}:v`;
  const LIST = "omok:rooms";
  const pk = (id) => `omok:room:${id}:seen`;
  const LIVE = "omok:live";
  const LOG = "omok:log";
  const BANS = "omok:bans";
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
      await redis.zremrangebyscore(LIVE, 0, Date.now() - TTL_SEC * 1000);
      const alive = new Set(await redis.zrange(LIVE, Date.now() - LIST_LIVE_MS, "+inf", { byScore: true }));
      const rooms = await redis.mget(...ids.map(rk));
      return rooms.map(parse).filter(Boolean).map(summary).filter((s) => s.players > 0 && alive.has(s.id));
    },
    async touch(id, playerId, info) {
      await redis.hset(pk(id), { [playerId]: JSON.stringify(info) });
      await redis.expire(pk(id), 600);
    },
    async markLive(id, at) {
      await redis.zadd(LIVE, { score: at, member: id });
    },
    async remove(id) {
      await redis.del(rk(id), vk(id), pk(id));
      await redis.zrem(LIST, id);
      await redis.zrem(LIVE, id);
      await redis.publish(`omok:ch:${id}`, "gone");
    },
    /** pub/sub push: fn() on every change of this room. Returns an async stop(). */
    async watch(id, fn) {
      const sub = redis.subscribe([`omok:ch:${id}`]);
      sub.on("message", () => fn());
      sub.on("error", (e) => console.warn("[omok] subscribe error", e?.message ?? e));
      return async () => {
        try {
          await sub.unsubscribe();
        } catch {}
      };
    },
    async allRooms() {
      const ids = await redis.zrange(LIST, 0, 199, { rev: true });
      if (!ids.length) return [];
      const rooms = await redis.mget(...ids.map(rk));
      const out = [];
      for (const r of rooms.map(parse).filter(Boolean)) {
        const liveAt = await redis.zscore(LIVE, r.id);
        out.push({ ...summary(r), liveAt: liveAt == null ? null : Number(liveAt) });
      }
      return out;
    },
    async addLog(entry) {
      const member = JSON.stringify({ ...entry, k: randomBytes(4).toString("hex") });
      await redis.zadd(LOG, { score: entry.at, member });
      await redis.zremrangebyscore(LOG, 0, Date.now() - LOG_KEEP_MS);
      await redis.zremrangebyrank(LOG, 0, -(LOG_MAX + 1));
    },
    async logs() {
      const rows = await redis.zrange(LOG, 0, LOG_MAX - 1, { rev: true });
      const cutoff = Date.now() - LOG_KEEP_MS;
      return rows.map(parse).filter((l) => l && l.at >= cutoff);
    },
    async ban(ip, info) {
      await redis.hset(BANS, { [ip]: JSON.stringify(info) });
    },
    async unban(ip) {
      await redis.hdel(BANS, ip);
    },
    async bans() {
      const h = (await redis.hgetall(BANS)) ?? {};
      return Object.fromEntries(Object.entries(h).map(([k, v]) => [k, parse(v)]));
    },
    async isBanned(ip) {
      return Boolean(await redis.hexists(BANS, ip));
    },
    async adminFail(ip) {
      const k = `omok:adminfail:${ip}`;
      await redis.incr(k);
      await redis.expire(k, 900);
    },
    async adminFails(ip) {
      return Number((await redis.get(`omok:adminfail:${ip}`)) ?? 0);
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

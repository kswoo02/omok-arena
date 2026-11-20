// Single Vercel function for every /api/* path (see vercel.json rewrite).
import { Redis } from "@upstash/redis";
import { adminRoute, clientIp } from "../server/admin.js";
import { route, stream } from "../server/handlers.js";
import { memoryStore, redisStore } from "../server/store.js";

let store;
export function getStore() {
  if (store) return store;
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) store = redisStore(new Redis({ url, token }));
  else {
    console.warn("[omok] Redis 환경변수가 없어 메모리 저장소를 씁니다 (로컬 전용)");
    store = memoryStore();
  }
  return store;
}
export function setStore(s) {
  store = s;
}

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") return safeParse(req.body);
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) break;
  }
  return safeParse(raw);
}
function safeParse(s) {
  try {
    return s ? JSON.parse(s) : {};
  } catch {
    return {};
  }
}

// banned IPs, cached briefly per function instance to save Redis calls
const banCache = new Map();
async function banned(s, ip) {
  const c = banCache.get(ip);
  if (c && c.until > Date.now()) return c.v;
  const v = await s.isBanned(ip);
  banCache.set(ip, { v, until: Date.now() + 15_000 });
  return v;
}
export function clearBanCache() {
  banCache.clear();
}

function send(res, status, json) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(json));
}

export default async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  const ip = clientIp(req);
  const ua = String(req.headers["user-agent"] ?? "").slice(0, 300);
  const city = (() => {
    try {
      return decodeURIComponent(String(req.headers["x-vercel-ip-city"] ?? ""));
    } catch {
      return "";
    }
  })();
  const region = [city, String(req.headers["x-vercel-ip-country"] ?? "")].filter(Boolean).join(", ");
  // after the rewrite Vercel may hand us /api/index?path=..., keep the original path
  const path = url.searchParams.get("__path") ? `/api/${url.searchParams.get("__path")}` : url.pathname;
  const query = Object.fromEntries(url.searchParams);
  const s = getStore();

  if (path.startsWith("/api/admin")) {
    try {
      const body = req.method === "POST" ? await readJson(req) : {};
      const out = await adminRoute({ method: req.method, path, query, body, headers: req.headers, ip, ua, region }, s);
      if (path.endsWith("/ban") || path.endsWith("/unban")) banCache.clear();
      return send(res, out.status, out.json);
    } catch (e) {
      console.error(e);
      return send(res, 500, { error: { code: "server", reason: "서버 오류가 났어요" } });
    }
  }
  if (await banned(s, ip)) return send(res, 403, { error: { code: "banned", reason: "이 접속은 운영자가 차단했어요" } });

  const m = path.match(/^\/api\/rooms\/([a-z0-9]{6,12})\/stream$/);
  if (m && req.method === "GET") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let closed = false;
    req.on("close", () => (closed = true));
    await stream(
      { id: m[1], playerId: query.playerId || "", since: Number(query.v ?? -1) },
      s,
      (chunk) => res.write(chunk),
      () => closed,
    );
    res.end();
    return;
  }

  try {
    const body = req.method === "POST" ? await readJson(req) : {};
    const out = await route({ method: req.method, path, query, body, ip, ua, region }, s);
    send(res, out.status, out.json);
  } catch (e) {
    console.error(e);
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { code: "server", reason: "서버 오류가 났어요" } }));
  }
}

export const config = { maxDuration: 30 };

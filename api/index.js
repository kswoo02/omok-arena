// Single Vercel function for every /api/* path (see vercel.json rewrite).
import { Redis } from "@upstash/redis";
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

export default async function handler(req, res) {
  const url = new URL(req.url, "http://localhost");
  // after the rewrite Vercel may hand us /api/index?path=..., keep the original path
  const path = url.searchParams.get("__path") ? `/api/${url.searchParams.get("__path")}` : url.pathname;
  const query = Object.fromEntries(url.searchParams);
  const s = getStore();

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
    const out = await route({ method: req.method, path, query, body }, s);
    res.writeHead(out.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(out.json));
  } catch (e) {
    console.error(e);
    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: { code: "server", reason: "서버 오류가 났어요" } }));
  }
}

export const config = { maxDuration: 30 };

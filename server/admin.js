// Admin: who connected (IP, device), what happened, open rooms, IP bans.
// Credentials come from env (ADMIN_ID, ADMIN_PASSWORD, ADMIN_SECRET) — never from code.
import { createHmac, timingSafeEqual } from "node:crypto";

export const LOG_KEEP_MS = 7 * 86_400_000; // logs are kept 7 days
const TOKEN_MS = 12 * 3_600_000;
const MAX_LOGIN_FAILS = 10; // per IP per 15 min

let override = null;
export function setAdminConfig(cfg) {
  override = cfg;
}
export function adminConfig() {
  return override ?? {
    id: process.env.ADMIN_ID ?? "",
    password: process.env.ADMIN_PASSWORD ?? "",
    secret: process.env.ADMIN_SECRET ?? "",
  };
}

export function clientIp(req) {
  const h = req.headers ?? {};
  const real = String(h["x-real-ip"] ?? "").trim();
  if (real) return real;
  const fwd = String(h["x-forwarded-for"] ?? "").split(",")[0].trim();
  if (fwd) return fwd;
  const sock = req.socket?.remoteAddress;
  return sock ? sock.replace(/^::ffff:/, "") : "unknown";
}

/** "휴대폰 · iOS · Safari" style summary */
export function device(ua = "") {
  if (!ua) return "알 수 없음";
  const kind = /iPad|Tablet/i.test(ua) ? "태블릿" : /Mobi|iPhone|Android/i.test(ua) ? "휴대폰" : "PC";
  const os = /iPhone|iPad|iOS/.test(ua) ? "iOS"
    : /Android/.test(ua) ? "Android"
    : /Windows/.test(ua) ? "Windows"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS"
    : /Linux/.test(ua) ? "Linux" : "기타";
  const browser = /KAKAOTALK/i.test(ua) ? "카카오톡"
    : /NAVER/.test(ua) ? "네이버"
    : /SamsungBrowser/.test(ua) ? "삼성 인터넷"
    : /Edg\//.test(ua) ? "Edge"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\/|CriOS\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari" : "기타";
  return `${kind} · ${os} · ${browser}`;
}

const mac = (secret, s) => createHmac("sha256", secret).update(s).digest("base64url");
const same = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
};

export function signToken(secret, exp) {
  return `${exp}.${mac(secret, String(exp))}`;
}
export function verifyToken(secret, token, now = Date.now()) {
  const [exp, sig] = String(token ?? "").split(".");
  if (!secret || !exp || !sig || !/^\d+$/.test(exp) || Number(exp) < now) return false;
  return same(sig, mac(secret, exp));
}
export function checkLogin(cfg, id, password) {
  if (!cfg.id || !cfg.password) return false;
  return same(cfg.id, id ?? "") && same(cfg.password, password ?? "");
}

/** write one event; ctx = { ip, ua, region } of the request */
export async function logEvent(store, ctx, type, fields = {}) {
  if (!ctx) return;
  try {
    await store.addLog({ at: Date.now(), type, ip: ctx.ip, region: ctx.region || "", device: device(ctx.ua), ...fields });
  } catch (e) {
    console.warn("[omok] log failed", e.message);
  }
}

const res = (status, json) => ({ status, json });
const KST = 9 * 3_600_000;
const kstMidnight = (now) => Math.floor((now + KST) / 86_400_000) * 86_400_000 - KST;

/** /api/admin/* -> { status, json } */
export async function adminRoute({ method, path, query = {}, body = {}, headers = {}, ip, ua, region }, store) {
  const cfg = adminConfig();
  const action = path.replace(/^\/api\/admin\/?/, "");
  if (!cfg.id || !cfg.password || !cfg.secret) {
    return res(503, { error: { code: "admin_off", reason: "관리자 계정이 설정되지 않았어요 (ADMIN_ID / ADMIN_PASSWORD / ADMIN_SECRET)" } });
  }

  if (action === "login" && method === "POST") {
    if ((await store.adminFails(ip)) >= MAX_LOGIN_FAILS) {
      return res(429, { error: { code: "locked", reason: "로그인 실패가 많아 15분 동안 막혔어요" } });
    }
    if (!checkLogin(cfg, body.id, body.password)) {
      await store.adminFail(ip);
      await logEvent(store, { ip, ua, region }, "admin_fail", { name: String(body.id ?? "").slice(0, 30) });
      return res(401, { error: { code: "login", reason: "아이디 또는 비밀번호가 맞지 않아요" } });
    }
    await logEvent(store, { ip, ua, region }, "admin_login", { name: cfg.id });
    return res(200, { token: signToken(cfg.secret, Date.now() + TOKEN_MS) });
  }

  const token = String(headers.authorization ?? "").replace(/^Bearer\s+/i, "");
  if (!verifyToken(cfg.secret, token)) return res(401, { error: { code: "auth", reason: "다시 로그인해 주세요" } });

  if (action === "logs" && method === "GET") {
    const f = (k) => String(query[k] ?? "").trim().toLowerCase();
    const want = { ip: f("ip"), name: f("name"), room: f("room"), type: f("type") };
    const logs = (await store.logs())
      .filter((l) => (!want.ip || String(l.ip).toLowerCase().includes(want.ip))
        && (!want.name || String(l.name ?? "").toLowerCase().includes(want.name))
        && (!want.room || String(l.room ?? "").toLowerCase().includes(want.room))
        && (!want.type || l.type === want.type))
      .slice(0, Math.min(Number(query.limit) || 300, 1000));
    return res(200, { logs });
  }
  if (action === "rooms" && method === "GET") return res(200, { rooms: await store.allRooms() });
  if (action === "stats" && method === "GET") {
    const now = Date.now();
    const today = (await store.logs()).filter((l) => l.at >= kstMidnight(now));
    const uniq = (xs) => new Set(xs).size;
    return res(200, {
      todayIps: uniq(today.filter((l) => !l.type.startsWith("admin")).map((l) => l.ip)),
      todayNames: uniq(today.filter((l) => l.name && !l.type.startsWith("admin")).map((l) => l.name)),
      todayRooms: today.filter((l) => l.type === "create").length,
      todayGames: today.filter((l) => l.type === "game_end").length,
      openRooms: (await store.allRooms()).filter((r) => r.players > 0).length,
      bans: Object.keys(await store.bans()).length,
    });
  }
  if (action === "bans" && method === "GET") return res(200, { bans: await store.bans() });
  if (action === "ban" && method === "POST") {
    const target = String(body.ip ?? "").trim();
    if (!target || target.length > 64) return res(400, { error: { code: "ip", reason: "차단할 IP를 입력해 주세요" } });
    if (target === ip) return res(400, { error: { code: "self", reason: "지금 접속한 내 IP는 차단할 수 없어요" } });
    await store.ban(target, { at: Date.now(), reason: String(body.reason ?? "").slice(0, 60) });
    await logEvent(store, { ip, ua, region }, "admin_ban", { name: cfg.id, target });
    return res(200, { ok: true });
  }
  if (action === "unban" && method === "POST") {
    await store.unban(String(body.ip ?? "").trim());
    await logEvent(store, { ip, ua, region }, "admin_unban", { name: cfg.id, target: String(body.ip ?? "") });
    return res(200, { ok: true });
  }
  return res(404, { error: { code: "not_found", reason: "없는 주소예요" } });
}

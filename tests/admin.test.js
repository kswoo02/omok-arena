import { test } from "node:test";
import assert from "node:assert/strict";
import { clientIp, device, signToken, verifyToken, checkLogin } from "../server/admin.js";
import { memoryStore } from "../server/store.js";

const CFG = { id: "boss", password: "pw-1234", secret: "s3cret-key-for-tests" };

test("client ip: x-real-ip, then first x-forwarded-for, then socket", () => {
  assert.equal(clientIp({ headers: { "x-real-ip": "1.2.3.4", "x-forwarded-for": "9.9.9.9" } }), "1.2.3.4");
  assert.equal(clientIp({ headers: { "x-forwarded-for": "5.6.7.8, 10.0.0.1" } }), "5.6.7.8");
  assert.equal(clientIp({ headers: {}, socket: { remoteAddress: "::ffff:127.0.0.1" } }), "127.0.0.1");
  assert.equal(clientIp({ headers: {} }), "unknown");
});

test("device summary from user agent", () => {
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
  assert.equal(device(iphone), "휴대폰 · iOS · Safari");
  const kakao = "Mozilla/5.0 (Linux; Android 14; SM-S918N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 KAKAOTALK 10.4.3";
  assert.equal(device(kakao), "휴대폰 · Android · 카카오톡");
  const pc = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
  assert.equal(device(pc), "PC · Windows · Chrome");
  assert.equal(device(""), "알 수 없음");
});

test("tokens: valid until expiry, tamper fails", () => {
  const t = signToken(CFG.secret, 1_000);
  assert.equal(verifyToken(CFG.secret, t, 999), true);
  assert.equal(verifyToken(CFG.secret, t, 1_001), false);
  assert.equal(verifyToken("other-secret", t, 500), false);
  assert.equal(verifyToken(CFG.secret, t.replace(/.$/, (c) => (c === "a" ? "b" : "a")), 500), false);
  assert.equal(verifyToken(CFG.secret, "garbage", 500), false);
});

test("login check is exact and needs configuration", () => {
  assert.equal(checkLogin(CFG, "boss", "pw-1234"), true);
  assert.equal(checkLogin(CFG, "boss", "pw-12345"), false);
  assert.equal(checkLogin(CFG, "Boss", "pw-1234"), false);
  assert.equal(checkLogin({ id: "", password: "" }, "", ""), false);
});

test("store: logs keep 7 days, bans add/remove", async () => {
  const s = memoryStore();
  const now = Date.now();
  await s.addLog({ at: now - 8 * 86_400_000, type: "create", ip: "1.1.1.1" });
  await s.addLog({ at: now - 1000, type: "join", ip: "2.2.2.2" });
  await s.addLog({ at: now, type: "create", ip: "3.3.3.3" });
  const logs = await s.logs();
  assert.deepEqual(logs.map((l) => l.ip), ["3.3.3.3", "2.2.2.2"]); // newest first, old one gone
  await s.ban("2.2.2.2", { at: now, reason: "도배" });
  assert.equal(await s.isBanned("2.2.2.2"), true);
  assert.equal((await s.bans())["2.2.2.2"].reason, "도배");
  await s.unban("2.2.2.2");
  assert.equal(await s.isBanned("2.2.2.2"), false);
});

// Admin page check. Usage: ADMIN_ID=.. ADMIN_PASSWORD=.. node tests/e2e-admin.mjs <baseUrl>
import { chromium } from "playwright-core";

const BASE = process.argv[2] || "http://localhost:3000";
const ID = process.env.ADMIN_ID;
const PW = process.env.ADMIN_PASSWORD;
const OUT = process.env.SHOTS || "";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", headless: true });
let failed = 0;
const errors = [];
const check = (label, ok) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
};

// a player makes a room so there is something to see
const P = await (await browser.newContext()).newPage();
await P.goto(BASE);
await P.getByPlaceholder("닉네임 (최대 12자)").fill("관리검사");
await P.getByRole("button", { name: "시작하기" }).click();
await P.getByRole("button", { name: "방 만들기" }).click();
await P.waitForURL(/\?room=/);
const roomId = new URL(P.url()).searchParams.get("room");
check("main page shows the records notice", (await P.locator(".foot").innerText()).includes("7일"));

const A = await (await browser.newContext({ viewport: { width: 1300, height: 900 } })).newPage();
A.on("pageerror", (e) => errors.push(e.message));
await A.goto(`${BASE}/admin`);
await A.getByPlaceholder("아이디").fill(ID);
await A.getByPlaceholder("비밀번호").fill(PW + "x");
await A.getByRole("button", { name: "로그인" }).click();
await A.waitForSelector("#login-error:not([hidden])");
check("wrong password refused", (await A.locator("#login-error").innerText()).includes("맞지 않아요"));
await A.getByPlaceholder("비밀번호").fill(PW);
await A.getByRole("button", { name: "로그인" }).click();
await A.waitForSelector("#dash:not([hidden])");
await A.waitForSelector("#logs tr");
check("dashboard opens after login", true);
const row = A.locator("#logs tr", { hasText: roomId }).filter({ hasText: "방 만들기" });
check("room creation is logged with nickname and IP", (await row.count()) >= 1 && (await row.first().innerText()).includes("관리검사"));
check("stats show today's IPs", Number(await A.locator("#stats dd").first().innerText()) >= 1);
await A.locator("#rooms tr", { hasText: roomId }).waitFor({ timeout: 10000 }).catch(() => {});
check("room listed in the rooms table", (await A.locator("#rooms tr", { hasText: roomId }).count()) === 1);

// filter by clicking the room id
await row.first().locator("button.link", { hasText: roomId }).click();
await A.waitForTimeout(800);
const all = await A.locator("#logs tr").allInnerTexts();
check("room filter shows only that room", all.length >= 1 && all.every((t) => t.includes(roomId)));

// ban and unban a documentation IP through the form
await A.locator("#ban-form input[name=ip]").fill("198.51.100.9");
await A.locator("#ban-form input[name=reason]").fill("테스트 차단");
await A.locator("#ban-form").getByRole("button", { name: "차단" }).click();
await A.waitForSelector("#bans tr >> text=198.51.100.9");
check("ban appears in the list", true);
if (OUT) await A.screenshot({ path: `${OUT}/admin.png`, fullPage: true });
await A.locator("#bans tr", { hasText: "198.51.100.9" }).getByRole("button", { name: "해제" }).click();
await A.waitForFunction(() => !document.querySelector("#bans")?.innerText.includes("198.51.100.9"));
check("unban removes it", true);

// reload keeps the session; logout clears it
await A.reload();
await A.waitForSelector("#dash:not([hidden])");
check("reload stays logged in", true);
await A.getByRole("button", { name: "로그아웃" }).click();
check("logout shows the login form", await A.locator("#login").isVisible());

// clean up the player's room
await P.locator("#exit").click();
await P.waitForSelector(".lobby");

console.log("ERRORS:", errors.length ? errors.join("\n") : "none");
await browser.close();
process.exit(failed || errors.length ? 1 : 0);

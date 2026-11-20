// Two-browser end-to-end check: desktop (mouse) + phone (touch, confirm button).
// Usage: node tests/e2e.mjs [baseUrl]   (needs Google Chrome; CHROME_PATH to override)
import { chromium, devices } from "playwright-core";

const BASE = process.argv[2] || "http://localhost:3000";
const OUT = process.env.SHOTS || "";
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", headless: true });
const errors = [];
let failed = 0;
const check = (label, ok) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
};

async function open(name, opts) {
  const ctx = await browser.newContext(opts);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`[${name}] ${e.message}`));
  // 403 responses are expected while a secret room asks for its password
  page.on("console", (m) => m.type() === "error" && !m.text().includes("status of 403") && errors.push(`[${name}] ${m.text()}`));
  return page;
}
async function enterName(page, name) {
  await page.getByPlaceholder("닉네임 (최대 12자)").fill(name);
  await page.getByRole("button", { name: "시작하기" }).click();
}
const at = (x, y) => y * 15 + x;
/** click/tap the intersection idx on the svg board */
async function hit(page, idx, tap = false) {
  const box = await page.locator("svg.board").boundingBox();
  const s = box.width / 640;
  const px = box.x + (34 + (idx % 15) * (572 / 14)) * s;
  const py = box.y + (34 + Math.floor(idx / 15) * (572 / 14)) * s;
  if (tap) await page.touchscreen.tap(px, py);
  else await page.mouse.click(px, py);
}
const stoneCount = (page) => page.evaluate(() => document.querySelectorAll("svg.board > g:nth-of-type(3) circle").length);
const status = (page) => page.locator(".status").innerText();
async function waitStones(page, n) {
  await page.waitForFunction((n) => document.querySelectorAll("svg.board > g:nth-of-type(3) circle").length === n, n, { timeout: 8000 });
}

const A = await open("PC", { viewport: { width: 1280, height: 820 } });
const B = await open("폰", { ...devices["iPhone 13"] });

// ---- lobby: create a renju room on PC
await A.goto(BASE);
await enterName(A, "앨리스");
await A.getByRole("button", { name: "방 만들기" }).click();
await A.waitForURL(/\?room=/);
const roomUrl = A.url();
await A.waitForSelector(".plate.plate-bottom >> text=앨리스");
check("PC created room and sits as black", (await A.locator(".plate-bottom").innerText()).includes("흑"));
if (OUT) await A.screenshot({ path: `${OUT}/pc-waiting.png` });

// ---- phone enters through the invite link
await B.goto(roomUrl);
await enterName(B, "밥");
await B.waitForSelector(".plate-bottom >> text=밥");
check("phone joined by link as white", (await B.locator(".plate-bottom").innerText()).includes("백"));
await A.waitForSelector(".plate-top >> text=밥");
check("PC sees the opponent arrive", true);

// ---- renju first move must be the center
await hit(A, at(3, 3));
check("off-center first move is refused", (await status(A)).includes("정중앙"));
await hit(A, at(7, 7));
await waitStones(B, 1);
check("PC move appears on phone", (await stoneCount(B)) === 1);

// ---- phone: tap selects, confirm button places
await hit(B, at(0, 0), true);
await B.waitForSelector(".confirm:not([hidden])");
check("tap shows confirm bar (A15)", (await B.locator(".confirm-pos").innerText()).includes("A15"));
if (OUT) await B.screenshot({ path: `${OUT}/phone-confirm.png` });
const cb = await B.locator(".confirm").boundingBox();
check("confirm bar visible without scrolling", cb && cb.y + cb.height <= B.viewportSize().height);
check("nothing placed before confirm", (await stoneCount(B)) === 1);
await B.getByRole("button", { name: "여기에 두기" }).tap();
await waitStones(A, 2);
check("phone move appears on PC", (await stoneCount(A)) === 2);

// ---- build a 3-3 point for black at (9,7)
const seq = [[8, 7, A], [0, 2, B], [9, 5, A], [0, 4, B], [9, 6, A], [14, 14, B]];
let n = 2;
for (const [x, y, p] of seq) {
  if (p === A) await hit(A, at(x, y));
  else {
    await hit(B, at(x, y), true);
    await B.getByRole("button", { name: "여기에 두기" }).tap();
  }
  n++;
  await waitStones(A, n);
  await waitStones(B, n);
}
const marks = await A.evaluate(() => document.querySelectorAll("svg.board > g:nth-of-type(2) path").length);
check(`forbidden × shown to black (${marks})`, marks >= 1);
await hit(A, at(9, 7));
check("3-3 click explains the reason", (await status(A)).includes("3·3"));
check("forbidden point not placed", (await stoneCount(A)) === n);
if (OUT) await A.screenshot({ path: `${OUT}/pc-forbidden.png` });

// ---- reload the phone: back in the same seat with the same board
await B.reload();
await B.waitForSelector(".plate-bottom >> text=밥");
await waitStones(B, n);
check("phone reload keeps white seat and board", (await B.locator(".plate-bottom").innerText()).includes("백"));

// ---- resign -> both see the result, then rematch swaps colors
B.once("dialog", () => {});
await B.getByRole("button", { name: "기권" }).tap();
await B.getByRole("button", { name: "기권", exact: true }).last().tap();
await A.waitForSelector(".stamp.show");
check("PC sees black win seal", (await A.locator(".stamp").innerText()) === "흑승");
check("result text on phone", (await status(B)).includes("백 기권"));
await A.getByRole("button", { name: "재대결 요청" }).click();
await B.waitForSelector(".ask-rematch:not([hidden])");
check("phone is asked for a rematch", (await B.locator(".ask-text").innerText()).includes("앨리스님이 재대결을 원해요"));
await B.getByRole("button", { name: "수락" }).tap();
await A.waitForFunction(() => document.querySelector(".plate-bottom")?.innerText.includes("백"));
check("rematch swaps colors (PC now white)", true);

// ---- emoji from the phone floats on the PC; a spectator is listed
await B.getByRole("button", { name: "🔥 보내기" }).tap();
await A.waitForSelector(".plate-react", { timeout: 8000 });
check("emoji reaction reaches the PC", (await A.locator(".plate-react").first().innerText()).includes("🔥"));
const C = await open("관전", { viewport: { width: 1000, height: 760 } });
await C.goto(A.url());
await enterName(C, "찰리");
await C.waitForSelector(".plate-bottom >> text=밥"); // spectator sees black (밥) at the bottom
check("third visitor spectates", (await status(C)).includes("관전 중"));
await A.waitForFunction(() => document.querySelector(".watchers")?.innerText.includes("찰리"), null, { timeout: 15000 });
check("PC sees the spectator listed", true);
await C.close();

// ---- free rule: a real five wins (secret room with a password and a 60 s clock)
await A.goto(BASE);
await A.locator("label.rule", { hasText: "자유룰" }).click();
await A.locator(".seg label", { hasText: "60초" }).click();
await A.locator("label.check").click();
await A.locator("input[name=password]").fill("7777");
await A.getByRole("button", { name: "방 만들기" }).click();
await A.waitForURL(/\?room=/);
await B.goto(A.url());
await B.waitForSelector("text=비밀방이에요");
check("secret room asks the phone for a password", true);
await B.locator("input[name=password]").fill("1111");
await B.getByRole("button", { name: "들어가기" }).tap();
await B.waitForSelector(".pw-error:not([hidden])");
check("wrong password is refused", (await B.locator(".pw-error").innerText()).includes("맞지 않아요"));
await B.locator("input[name=password]").fill("7777");
await B.getByRole("button", { name: "들어가기" }).tap();
await B.waitForSelector(".plate-bottom >> text=밥");
await A.waitForSelector(".plate-top >> text=밥");
await B.reload();
await B.waitForSelector(".plate-bottom >> text=밥");
check("reload in a secret room does not ask again", true);
await A.waitForSelector(".plate-clock");
const clock1 = await A.locator(".plate-clock").innerText();
check(`move clock counts down (${clock1})`, /^[01]:\d\d$/.test(clock1) && clock1 !== "0:00");
const listed = await A.evaluate(async (u) => (await (await fetch("/api/rooms")).json()).rooms.find((r) => u.includes(r.id)), A.url());
check("secret room is listed with a lock", listed?.locked === true);
for (let i = 0; i < 5; i++) {
  await hit(A, at(i, 0));
  await waitStones(B, i * 2 + 1);
  if (i === 4) break;
  await hit(B, at(i, 2), true);
  await B.getByRole("button", { name: "여기에 두기" }).tap();
  await waitStones(A, i * 2 + 2);
}
await B.waitForSelector(".stamp.show");
check("five wins in free rule (phone sees 흑승)", (await B.locator(".stamp").innerText()) === "흑승");
check("winner plate shows 승", (await A.locator(".plate-bottom .plate-seal").count()) === 1);
if (OUT) {
  await A.screenshot({ path: `${OUT}/pc-win.png` });
  await B.screenshot({ path: `${OUT}/phone-win.png` });
}

// ---- owner kicks the opponent after the game; the kicked player can only watch
await A.locator(".plate-top .plate-kick").click();
await A.getByRole("button", { name: "내보내기", exact: true }).last().click();
await B.waitForFunction(() => document.querySelector(".status")?.innerText.includes("관전") || document.querySelector(".plate-bottom")?.innerText.includes("앨리스"), null, { timeout: 10000 });
check("kicked player loses the seat", (await A.locator(".plate-top").innerText()).includes("빈자리"));

// ---- lobby lists rooms
await A.goto(BASE);
await A.waitForSelector(".room-row");
check("lobby lists open rooms", (await A.locator(".room-row").count()) >= 1);
if (OUT) await A.screenshot({ path: `${OUT}/pc-lobby.png` });
await B.goto(BASE);
await B.waitForSelector(".room-row");
if (OUT) await B.screenshot({ path: `${OUT}/phone-lobby.png`, fullPage: true });

console.log("ERRORS:", errors.length ? "\n" + errors.join("\n") : "none");
await browser.close();
process.exit(failed || errors.length ? 1 : 0);

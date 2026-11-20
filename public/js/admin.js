// Admin dashboard: login, stats, logs with filters, rooms, IP bans.
const $ = (s, r = document) => r.querySelector(s);
const KEY = "omok:admin-token";

const TYPES = {
  create: "방 만들기",
  join: "입장",
  rejoin: "재접속",
  join_fail: "입장 실패",
  leave: "나가기",
  kick: "내보내기",
  resign: "기권",
  rematch: "재대결 요청",
  rematch_decline: "재대결 거절",
  game_start: "대국 시작",
  game_end: "대국 종료",
  admin_login: "관리자 로그인",
  admin_fail: "관리자 로그인 실패",
  admin_ban: "IP 차단",
  admin_unban: "차단 해제",
};
const BAD = new Set(["join_fail", "admin_fail", "kick", "admin_ban"]);
const GAME = new Set(["game_start", "game_end"]);

let token = null;
try {
  token = sessionStorage.getItem(KEY);
} catch {}

function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove("show"), 2600);
}
function ask(message, ok) {
  const d = $("#confirm-dialog");
  $(".dialog-msg", d).textContent = message;
  d.querySelector('[value="yes"]').textContent = ok;
  return new Promise((resolve) => {
    d.addEventListener("close", () => resolve(d.returnValue === "yes"), { once: true });
    d.showModal();
  });
}

async function call(method, path, body) {
  const r = await fetch(path, {
    method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== "/api/admin/login") {
    logout();
    throw new Error("다시 로그인해 주세요");
  }
  if (!r.ok) throw new Error(json.error?.reason ?? "요청을 처리하지 못했어요");
  return json;
}

const kst = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
});
const when = (t) => (t ? kst.format(new Date(t)) : "-");

function cell(row, text, cls) {
  const td = document.createElement("td");
  if (cls) td.className = cls;
  if (text instanceof Node) td.append(text);
  else td.textContent = text ?? "";
  row.append(td);
  return td;
}
function button(label, cls, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = cls;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

// ---------------- login ----------------
function show(logged) {
  $("#login").hidden = logged;
  $("#dash").hidden = !logged;
  $("#logout").hidden = !logged;
}
function logout() {
  token = null;
  try {
    sessionStorage.removeItem(KEY);
  } catch {}
  show(false);
}
$("#logout").addEventListener("click", logout);
$(".login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  const err = $("#login-error");
  try {
    const { token: t } = await call("POST", "/api/admin/login", { id: f.id.value, password: f.password.value });
    token = t;
    try {
      sessionStorage.setItem(KEY, t);
    } catch {}
    f.password.value = "";
    err.hidden = true;
    show(true);
    refresh();
  } catch (ex) {
    err.hidden = false;
    err.textContent = ex.message;
  }
});

// ---------------- dashboard ----------------
const typeSelect = $("#filters select[name=type]");
for (const [k, v] of Object.entries(TYPES)) {
  const o = document.createElement("option");
  o.value = k;
  o.textContent = v;
  typeSelect.append(o);
}

function filterQuery() {
  const f = $("#filters");
  const q = new URLSearchParams();
  for (const k of ["ip", "name", "room", "type"]) if (f[k].value.trim()) q.set(k, f[k].value.trim());
  return q.toString();
}

async function loadStats() {
  const s = await call("GET", "/api/admin/stats");
  const items = [
    ["오늘 접속한 IP", s.todayIps],
    ["오늘 닉네임", s.todayNames],
    ["오늘 만든 방", s.todayRooms],
    ["오늘 끝난 대국", s.todayGames],
    ["지금 사람 있는 방", s.openRooms],
    ["차단한 IP", s.bans],
  ];
  $("#stats").replaceChildren(...items.map(([k, v]) => {
    const d = document.createElement("div");
    const dt = document.createElement("dt");
    dt.textContent = k;
    const dd = document.createElement("dd");
    dd.textContent = v;
    d.append(dt, dd);
    return d;
  }));
}

async function loadLogs() {
  const { logs } = await call("GET", `/api/admin/logs?${filterQuery()}`);
  const rows = logs.map((l) => {
    const tr = document.createElement("tr");
    if (BAD.has(l.type)) tr.className = "warn";
    cell(tr, when(l.at), "nowrap");
    const tag = document.createElement("span");
    tag.className = `tag${BAD.has(l.type) ? " bad" : GAME.has(l.type) ? " game" : ""}`;
    tag.textContent = TYPES[l.type] ?? l.type;
    cell(tr, tag, "nowrap");
    cell(tr, l.name || "-");
    cell(tr, l.room ? button(l.room, "link", () => setFilter("room", l.room)) : "-", "nowrap");
    cell(tr, button(l.ip, "link", () => setFilter("ip", l.ip)), "nowrap");
    cell(tr, l.region || "-", "nowrap");
    cell(tr, l.device || "-", "nowrap");
    cell(tr, [l.reason, l.target && `대상 ${l.target}`].filter(Boolean).join(", ") || "");
    cell(tr, l.type.startsWith("admin") ? "" : button("차단", "mini", () => banIp(l.ip, l.name)));
    return tr;
  });
  $("#logs").replaceChildren(...rows);
  $("#logs-empty").hidden = rows.length > 0;
}

async function loadRooms() {
  const { rooms } = await call("GET", "/api/admin/rooms");
  const label = { waiting: "대기", playing: "대국 중", ended: "끝남" };
  const rows = rooms.map((r) => {
    const tr = document.createElement("tr");
    cell(tr, button(r.id, "link", () => setFilter("room", r.id)), "nowrap");
    cell(tr, `${r.locked ? "🔒 " : ""}${r.name}`);
    cell(tr, `${r.rule === "renju" ? "렌주" : "자유"}${r.timeLimit ? `, ${r.timeLimit}초` : ""}`, "nowrap");
    cell(tr, r.players ? label[r.status] ?? r.status : "비어 있음", "nowrap");
    cell(tr, r.names.join(", ") || "-");
    cell(tr, when(r.liveAt), "nowrap");
    return tr;
  });
  $("#rooms").replaceChildren(...rows);
  $("#rooms-empty").hidden = rows.length > 0;
}

async function loadBans() {
  const { bans } = await call("GET", "/api/admin/bans");
  const rows = Object.entries(bans).map(([ip, b]) => {
    const tr = document.createElement("tr");
    cell(tr, ip, "nowrap");
    cell(tr, b?.reason || "-");
    cell(tr, when(b?.at), "nowrap");
    cell(tr, button("해제", "mini undo", async () => {
      await call("POST", "/api/admin/unban", { ip });
      toast(`${ip} 차단을 풀었어요.`);
      refresh();
    }));
    return tr;
  });
  $("#bans").replaceChildren(...rows);
  $("#bans-empty").hidden = rows.length > 0;
}

async function banIp(ip, name) {
  if (!(await ask(`${ip}${name ? ` (${name})` : ""}을 차단할까요? 이 IP로는 방을 만들거나 들어올 수 없게 돼요.`, "차단"))) return;
  try {
    await call("POST", "/api/admin/ban", { ip, reason: name ? `${name} 접속` : "" });
    toast(`${ip}을 차단했어요.`);
    refresh();
  } catch (e) {
    toast(e.message);
  }
}

function setFilter(key, value) {
  const f = $("#filters");
  f[key].value = value;
  loadLogs().catch((e) => toast(e.message));
}

$("#filters").addEventListener("submit", (e) => {
  e.preventDefault();
  loadLogs().catch((ex) => toast(ex.message));
});
$("#filters").addEventListener("reset", () => setTimeout(() => loadLogs().catch(() => {}), 0));
$("#ban-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.currentTarget;
  try {
    await call("POST", "/api/admin/ban", { ip: f.ip.value.trim(), reason: f.reason.value.trim() });
    toast(`${f.ip.value.trim()}을 차단했어요.`);
    f.reset();
    refresh();
  } catch (ex) {
    toast(ex.message);
  }
});

let busy = false;
async function refresh() {
  if (!token || busy) return;
  busy = true;
  try {
    await Promise.all([loadStats(), loadLogs(), loadRooms(), loadBans()]);
  } catch (e) {
    toast(e.message);
  } finally {
    busy = false;
  }
}
setInterval(() => {
  if (token && $("#auto").checked && document.visibilityState === "visible") refresh();
}, 10_000);

show(!!token);
if (token) refresh();

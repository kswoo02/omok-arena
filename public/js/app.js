import { api, nickname, playerId } from "./api.js";
import { createBoard, label } from "./board.js";

const $ = (sel, root = document) => root.querySelector(sel);
const app = $("#app");
const CENTER = 112;

// ---------------- small UI helpers ----------------
let toastTimer;
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
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

function mount(id) {
  app.replaceChildren($(`#${id}`).content.cloneNode(true));
}

function updateWho() {
  const who = $("#who");
  const n = nickname();
  who.hidden = !n;
  who.textContent = n ? `${n}님` : "";
  who.title = "닉네임 바꾸기";
  who.setAttribute("aria-label", `${n ?? ""}, 닉네임 바꾸기`);
}
$("#who").addEventListener("click", () => {
  nickname(null);
  updateWho();
  route();
});

// passwords typed for secret rooms, kept for this tab so a reload does not ask again
function rememberPw(id, pw) {
  try {
    if (pw) sessionStorage.setItem(`omok:pw:${id}`, pw);
  } catch {}
}
function savedPw(id) {
  try {
    return sessionStorage.getItem(`omok:pw:${id}`) || undefined;
  } catch {
    return undefined;
  }
}

// ---------------- routing ----------------
let cleanup = () => {};
/** set by the game screen: resolves true when it is fine to leave (seat given up), false to stay */
let beforeLeave = null;
let roomUrl = null;

async function go(roomId) {
  if (beforeLeave && !(await beforeLeave())) return;
  const url = roomId ? `/?room=${roomId}` : "/";
  history.pushState(null, "", url);
  route();
}
window.addEventListener("popstate", async () => {
  if (beforeLeave && roomUrl && location.search !== roomUrl) {
    if (!(await beforeLeave())) {
      history.pushState(null, "", roomUrl); // stay in the room
      return;
    }
  }
  route();
});
document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-nav=lobby]");
  if (a) {
    e.preventDefault();
    go(null);
  }
});
$("#exit").addEventListener("click", () => go(null));

function route() {
  cleanup();
  cleanup = () => {};
  beforeLeave = null;
  roomUrl = null;
  updateWho();
  $("#exit").hidden = true;
  const roomId = new URLSearchParams(location.search).get("room");
  if (!nickname()) return nameGate(roomId);
  if (roomId) {
    $("#who").hidden = true; // in a room the corner holds the leave button instead
    $("#exit").hidden = false;
    roomUrl = location.search;
    cleanup = game(roomId.toLowerCase());
  } else cleanup = lobby();
}

function nameGate(roomId) {
  mount("tpl-name");
  if (roomId) $(".gate-sub").textContent = "친구가 보낸 방에 들어가요. 상대에게 보이는 닉네임을 정해 주세요.";
  const form = $(".name-form");
  const input = form.nickname;
  input.focus();
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const n = input.value.replace(/\s+/g, " ").trim().slice(0, 12);
    if (!n) return input.focus();
    nickname(n);
    route();
  });
}

// ---------------- lobby ----------------
function lobby() {
  mount("tpl-lobby");
  document.title = "수담 오목";
  const list = $(".room-list");
  const empty = $(".empty");
  let alive = true;

  async function load() {
    try {
      const { rooms } = await api.rooms();
      if (!alive) return;
      list.replaceChildren(...rooms.map(roomRow));
      empty.hidden = rooms.length > 0;
    } catch (e) {
      if (alive) empty.hidden = false, (empty.textContent = e.message);
    }
  }

  function roomRow(r) {
    const li = document.createElement("li");
    li.className = "room-row";
    const seats = document.createElement("span");
    seats.className = "seats";
    seats.setAttribute("aria-label", `${r.players}/2명`);
    seats.innerHTML = `<i class="${r.players >= 1 ? "b" : ""}"></i><i class="${r.players >= 2 ? "w" : ""}"></i>`;
    const info = document.createElement("span");
    info.style.minWidth = "0";
    const title = document.createElement("span");
    title.className = "room-title";
    title.textContent = r.name;
    const badge = document.createElement("span");
    badge.className = `badge ${r.rule}`;
    badge.textContent = r.rule === "renju" ? "렌주" : "자유";
    title.append(" ", badge);
    if (r.locked) {
      const lock = document.createElement("span");
      lock.className = "badge lock-b";
      lock.textContent = "🔒 비밀방";
      title.append(" ", lock);
    }
    if (r.timeLimit) {
      const clock = document.createElement("span");
      clock.className = "badge clock-b";
      clock.textContent = `${r.timeLimit}초`;
      title.append(" ", clock);
    }
    const sub = document.createElement("span");
    sub.className = "room-sub";
    const who = r.names.join(", ");
    sub.textContent =
      r.status === "playing" ? `${who} 대국 중`
      : r.status === "ended" ? `${who} 대국을 마쳤어요`
      : `${who}님이 상대를 기다리는 중`;
    info.append(title, sub);
    const btn = document.createElement("button");
    btn.className = r.players >= 2 ? "btn btn-line" : "btn btn-ink";
    btn.type = "button";
    btn.textContent = r.players >= 2 ? "관전" : "참가";
    btn.addEventListener("click", () => go(r.id));
    li.append(seats, info, btn);
    return li;
  }

  const form = $(".new-room");
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = form.querySelector("button[type=submit]");
    btn.disabled = true;
    try {
      const password = form.secret.checked ? form.password.value : "";
      if (form.secret.checked && (password.length < 4 || password.length > 20)) {
        btn.disabled = false;
        form.password.focus();
        return toast("비밀번호는 4~20자로 정해 주세요.");
      }
      const { room } = await api.create(form.name.value, form.rule.value, {
        timeLimit: Number(form.timeLimit.value),
        ...(password ? { password } : {}),
      });
      rememberPw(room.id, password);
      go(room.id);
    } catch (err) {
      toast(err.message);
      btn.disabled = false;
    }
  });
  form.secret.addEventListener("change", () => {
    $(".pw-field").hidden = !form.secret.checked;
    if (form.secret.checked) form.password.focus();
  });
  $("[data-refresh]").addEventListener("click", load);

  load();
  const timer = setInterval(() => document.visibilityState === "visible" && load(), 5000);
  return () => {
    alive = false;
    clearInterval(timer);
  };
}

// ---------------- game ----------------
function game(id, initial = null) {
  mount("tpl-game");
  const svg = $(".board");
  const plates = { top: $("[data-plate=top]"), bottom: $("[data-plate=bottom]") };
  const statusEl = $(".status");
  const confirmBar = $(".confirm");
  const stamp = $(".stamp");
  let room = null;
  let selected = -1;
  let busy = false;
  let es = null;
  let alive = true;
  let stamped = null;
  let clockOffset = 0; // server time - local time
  let reactSeq = null;
  const EMOJIS = ["👍", "😮", "😂", "😭", "🔥", "👏"];

  const board = createBoard(svg, { onPick: pick });
  const emojiBar = $(".emojis");
  for (const e of EMOJIS) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = e;
    b.setAttribute("aria-label", `${e} 보내기`);
    b.addEventListener("click", () => sendReaction(e));
    emojiBar.append(b);
  }

  function myColor() {
    return room?.me === "black" ? 1 : room?.me === "white" ? 2 : 0;
  }
  function myTurn() {
    return room?.status === "playing" && myColor() === room.turn;
  }

  function apply(next) {
    if (!next || (room && next.version < room.version)) return;
    const moved = room && next.moveCount !== room.moveCount;
    const declined = room && room.rematch.mine && next.rematch.declined > room.rematch.declined;
    clockOffset = next.serverNow - Date.now();
    room = next;
    if (moved || !myTurn()) selected = -1;
    render();
    if (declined) toast("상대가 재대결을 거절했어요.");
    const r = room.reaction;
    if (r && reactSeq !== null && r.seq > reactSeq) showReaction(r);
    if (r) reactSeq = Math.max(reactSeq ?? 0, r.seq);
    else if (reactSeq === null) reactSeq = 0;
  }

  function showReaction(r) {
    const bottomSeat = room.me ?? "black";
    const host = !r.seat ? $(".board-wrap") : r.seat === bottomSeat ? plates.bottom : plates.top;
    const el = document.createElement("span");
    el.className = r.seat ? "plate-react" : "react-float";
    el.textContent = r.emoji;
    if (!r.seat) {
      const who = document.createElement("small");
      who.textContent = r.name;
      el.append(who);
    }
    host.append(el);
    setTimeout(() => el.remove(), 2300);
  }

  async function sendReaction(e) {
    const buttons = [...emojiBar.children];
    buttons.forEach((b) => (b.disabled = true));
    setTimeout(() => buttons.forEach((b) => (b.disabled = false)), 2000);
    try {
      apply((await api.react(id, e)).room);
    } catch (err) {
      toast(err.message);
    }
  }

  function clockText(deadline) {
    const left = Math.max(0, Math.ceil((deadline - (Date.now() + clockOffset)) / 1000));
    return { text: `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`, low: left <= 10 };
  }
  function tickClock() {
    const el = document.querySelector(".plate-clock");
    if (!el || !room?.deadline) return;
    const c = clockText(room.deadline);
    el.textContent = c.text;
    el.classList.toggle("low", c.low);
  }

  function plate(el, seat) {
    const s = room.seats[seat];
    const color = seat === "black" ? 1 : 2;
    const turn = room.status === "playing" && room.turn === color;
    el.classList.toggle("turn", turn);
    const floating = [...el.querySelectorAll(".plate-react")]; // keep reactions alive across re-renders
    el.replaceChildren(...floating);
    const stone = document.createElement("span");
    stone.className = `stone ${s ? (color === 1 ? "b" : "w") : "none"}`;
    const name = document.createElement("span");
    name.className = "plate-name";
    name.textContent = s ? s.name : "빈자리";
    const small = document.createElement("small");
    small.textContent = `${color === 1 ? "흑" : "백"}${room.me === seat ? ", 나" : ""}`;
    name.append(small);
    el.append(stone, name);
    if (s && s.online === false) {
      const away = document.createElement("span");
      away.className = "plate-away";
      away.textContent = "자리 비움";
      el.append(away);
    }
    if (s && room.owner && room.me && room.me !== seat && (room.status !== "playing" || s.online === false)) {
      const k = document.createElement("button");
      k.type = "button";
      k.className = "plate-kick";
      k.dataset.act = "kick";
      k.textContent = "내보내기";
      el.append(k);
    }
    if (turn) {
      const tag = document.createElement("span");
      tag.className = "plate-tag";
      tag.textContent = room.me === seat ? "내 차례" : "두는 중";
      el.append(tag);
      if (room.deadline) {
        const c = clockText(room.deadline);
        const clock = document.createElement("span");
        clock.className = `plate-clock${c.low ? " low" : ""}`;
        clock.textContent = c.text;
        clock.setAttribute("aria-label", "남은 시간");
        el.append(clock);
      }
    }
    if (room.status === "ended" && room.result?.winner === color) {
      const seal = document.createElement("span");
      seal.className = "plate-seal";
      seal.textContent = "승";
      el.append(seal);
    }
  }

  function statusText() {
    const turnName = room.turn === 1 ? "흑" : "백";
    if (room.status === "waiting") {
      return room.me ? "상대를 기다리는 중이에요. 초대 링크를 보내 보세요." : "자리가 비어 있어요.";
    }
    if (room.status === "ended") {
      const r = room.result;
      if (!r) return "대국이 끝났어요.";
      const mine = r.winner && r.winner === myColor();
      const tail = room.me ? (mine ? " 이겼어요!" : r.winner ? " 아쉽게 졌어요." : "") : "";
      const opp = room.me && !room.seats[room.me === "black" ? "white" : "black"];
      return `${r.reason}.${tail}${opp ? " 상대가 방을 나갔어요. 새 상대가 들어오면 바로 시작해요." : ""}`;
    }
    if (!room.me) return `관전 중이에요. ${turnName} 차례예요.`;
    if (myTurn()) {
      if (room.centerOnly) return "내 차례예요. 렌주룰이라 첫 수는 판 정중앙에 둬요.";
      return room.forbidden.length && room.me === "black"
        ? "내 차례예요. × 자리는 금수라 둘 수 없어요."
        : "내 차례예요.";
    }
    return "상대가 두는 중이에요.";
  }

  function render() {
    document.title = `${room.name} · 수담 오목`;
    $(".room-name").textContent = room.name;
    const badge = $(".rule-badge");
    badge.textContent = room.rule === "renju" ? "렌주룰" : "자유룰";
    badge.className = `badge rule-badge ${room.rule}`;
    $(".room-meta").querySelectorAll(".meta-extra").forEach((n) => n.remove());
    for (const [on, text, cls] of [[room.timeLimit, `한 수 ${room.timeLimit}초`, "clock-b"], [room.locked, "🔒 비밀방", "lock-b"]]) {
      if (!on) continue;
      const b = document.createElement("span");
      b.className = `badge meta-extra ${cls}`;
      b.textContent = text;
      $(".room-meta").append(b);
    }
    // my plate at the bottom (black when spectating)
    const mine = room.me ?? "black";
    plate(plates.bottom, mine);
    plate(plates.top, mine === "black" ? "white" : "black");
    statusEl.textContent = statusText();
    statusEl.classList.remove("warn");

    const showForbidden = room.status === "playing" && room.turn === 1 && room.rule === "renju";
    board.render({
      board: room.board,
      lastMove: room.lastMove,
      winLine: room.result?.line,
      forbidden: showForbidden ? room.forbidden : [],
      selected,
      interactive: myTurn() && !busy,
      ghost: myColor() || 1,
    });

    confirmBar.hidden = selected < 0;
    if (selected >= 0) $(".confirm-pos").textContent = `${label(selected)}에 둘까요?`;

    const seated = !!room.me;
    const opponent = room.me ? room.seats[room.me === "black" ? "white" : "black"] : null;
    const asked = seated && room.status === "ended" && room.rematch.fromOther;
    $(".ask-rematch").hidden = !asked;
    if (asked) $(".ask-text").textContent = `${opponent?.name ?? "상대"}님이 재대결을 원해요. 흑백을 바꿔 새 판을 시작해요.`;
    const watchers = $(".watchers");
    watchers.hidden = !room.spectators?.length;
    watchers.textContent = room.spectators?.length ? `관전 ${room.spectators.length}명: ${room.spectators.join(", ")}` : "";
    const rematch = $("[data-act=rematch]");
    rematch.hidden = !(seated && room.status === "ended" && opponent) || asked;
    rematch.disabled = room.rematch.mine;
    rematch.textContent = room.rematch.mine ? "재대결 요청함, 응답을 기다리는 중" : "재대결 요청";
    $("[data-act=resign]").hidden = !(seated && room.status === "playing");

    const key = room.status === "ended" && room.result?.winner ? `${room.moveCount}|${room.result.reason}` : null;
    if (key && key !== stamped) {
      stamped = key;
      stamp.textContent = room.result.winner === 1 ? "흑승" : "백승";
      stamp.classList.remove("show");
      void stamp.offsetWidth;
      stamp.classList.add("show");
    } else if (!key) {
      stamped = null;
      stamp.classList.remove("show");
    }
  }

  function warn(text) {
    statusEl.textContent = text;
    statusEl.classList.add("warn");
  }

  function pick(idx, coarse) {
    if (!room || busy) return;
    if (!room.me) return toast("관전 중에는 둘 수 없어요.");
    if (room.status !== "playing") return;
    if (!myTurn()) return warn("상대 차례예요.");
    if (room.board[idx] !== 0) return;
    if (room.centerOnly && idx !== CENTER) return warn("렌주룰: 흑 첫 수는 판 정중앙에 둬야 해요.");
    const f = room.me === "black" && room.rule === "renju" ? room.forbidden.find((q) => q.idx === idx) : null;
    if (f) return warn(`${f.reason}라서 둘 수 없어요.`);
    if (coarse) {
      selected = idx; // phones: choose, then confirm
      render();
      confirmBar.querySelector("[data-act=place]").focus({ preventScroll: true });
      return;
    }
    place(idx);
  }

  async function place(idx) {
    busy = true;
    render();
    try {
      const { room: next } = await api.move(id, idx);
      selected = -1;
      busy = false;
      apply(next);
    } catch (e) {
      busy = false;
      render();
      warn(e.message);
    }
  }

  async function act(name) {
    try {
      if (name === "place") return selected >= 0 && place(selected);
      if (name === "cancel") {
        selected = -1;
        return render();
      }
      if (name === "invite") {
        const url = `${location.origin}/?room=${id}`;
        try {
          await navigator.clipboard.writeText(url);
          toast("초대 링크를 복사했어요. 친구에게 보내 주세요.");
        } catch {
          await ask(url, "확인");
        }
        return;
      }
      if (name === "resign") {
        if (!(await ask("기권할까요? 상대의 승리로 끝나요.", "기권"))) return;
        return apply((await api.resign(id)).room);
      }
      if (name === "rematch" || name === "accept") return apply((await api.rematch(id)).room);
      if (name === "decline") return apply((await api.decline(id)).room);
      if (name === "kick") {
        const opp = room.seats[room.me === "black" ? "white" : "black"];
        if (!(await ask(`${opp?.name ?? "상대"}님을 내보낼까요? 이 방에서는 관전만 할 수 있게 돼요.`, "내보내기"))) return;
        return apply((await api.kick(id)).room);
      }
      if (name === "leave") return go(null);
    } catch (e) {
      toast(e.message);
    }
  }
  // every way out (corner button, logo, browser back) gives the seat up; mid-game it is a resign
  beforeLeave = async () => {
    if (room?.me) {
      if (room.status === "playing" && !(await ask("대국 중이에요. 기권하고 나갈까요?", "기권하고 나가기"))) return false;
      try {
        await api.leave(id);
      } catch {}
    }
    return true;
  };
  $(".game").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (b) act(b.dataset.act);
  });

  function connect() {
    if (!alive || es || document.visibilityState !== "visible") return;
    es = new EventSource(api.streamUrl(id, room?.version ?? -1));
    es.addEventListener("room", (e) => apply(JSON.parse(e.data)));
    es.addEventListener("presence", (e) => {
      if (!room) return;
      const p = JSON.parse(e.data);
      room = {
        ...room,
        spectators: p.spectators,
        seats: {
          black: room.seats.black && { ...room.seats.black, online: p.online.black },
          white: room.seats.white && { ...room.seats.white, online: p.online.white },
        },
      };
      render();
    });
    es.addEventListener("gone", () => {
      disconnect();
      statusEl.textContent = "방이 사라졌어요. 로비에서 새 방을 만들어 주세요.";
    });
  }
  function disconnect() {
    es?.close();
    es = null;
  }
  async function onVisible() {
    if (document.visibilityState === "visible") {
      try {
        apply((await api.room(id)).room);
      } catch {}
      connect();
    } else disconnect();
  }
  document.addEventListener("visibilitychange", onVisible);
  const clockTimer = setInterval(tickClock, 250);
  const ping = () => document.visibilityState === "visible" && api.ping(id).catch(() => {});
  const pingTimer = setInterval(ping, 20_000);

  async function enter(password) {
    const { room: r, seat } = await api.join(id, password);
    if (password) rememberPw(id, password);
    apply(r);
    if (!seat) toast("자리가 다 찼어요. 관전으로 들어왔어요.");
    connect();
  }

  function askPassword(info, message) {
    app.replaceChildren($("#tpl-password").content.cloneNode(true));
    $(".gate-sub").textContent = `${info?.name ?? "이 방"}에 들어가려면 방장이 정한 비밀번호가 필요해요.`;
    const err = $(".pw-error");
    if (message) err.hidden = false, (err.textContent = message);
    const form = $(".pw-form");
    form.password.focus();
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const pw = form.password.value;
      try {
        const { room: r, seat } = await api.join(id, pw);
        rememberPw(id, pw);
        // the password screen replaced the game; rebuild it and continue with the joined room
        cleanup();
        cleanup = game(id, { room: r, seat });
      } catch (e2) {
        err.hidden = false;
        err.textContent = e2.message;
        form.password.select();
      }
    });
  }

  (async () => {
    try {
      if (initial) {
        apply(initial.room);
        if (!initial.seat) toast("자리가 다 찼어요. 관전으로 들어왔어요.");
        connect();
        return;
      }
      await enter(savedPw(id));
    } catch (e) {
      if (e.code === "password") return askPassword(e.room, savedPw(id) ? e.message : "");
      app.replaceChildren();
      const p = document.createElement("section");
      p.className = "name-gate";
      p.innerHTML = `<h1 class="gate-title">방에 들어갈 수 없어요</h1><p class="gate-sub"></p><a class="btn btn-ink" href="/" data-nav="lobby">로비로 가기</a>`;
      $(".gate-sub", p).textContent = e.message;
      app.append(p);
    }
  })();

  return () => {
    alive = false;
    disconnect();
    clearInterval(clockTimer);
    clearInterval(pingTimer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

playerId();
route();

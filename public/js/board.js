// SVG 15x15 board: drawing + pointer input. idx = y*15 + x.
export const SIZE = 15;
const NS = "http://www.w3.org/2000/svg";
const M = 34; // margin
const STEP = (640 - 2 * M) / (SIZE - 1);
const STARS = [[3, 3], [11, 3], [7, 7], [3, 11], [11, 11]];
const COLS = "ABCDEFGHIJKLMNO";

const el = (tag, attrs = {}, parent) => {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (parent) parent.appendChild(n);
  return n;
};
const pos = (i) => M + i * STEP;

/** "H8" style label, rows counted from the bottom */
export function label(idx) {
  return `${COLS[idx % SIZE]}${SIZE - Math.floor(idx / SIZE)}`;
}

export function createBoard(svg, { onPick }) {
  svg.innerHTML = "";
  const defs = el("defs", {}, svg);
  defs.innerHTML = `
    <radialGradient id="g-b" cx="35%" cy="30%" r="70%"><stop offset="0" stop-color="#626973"/><stop offset=".55" stop-color="#22262b"/><stop offset="1" stop-color="#121417"/></radialGradient>
    <radialGradient id="g-w" cx="35%" cy="30%" r="75%"><stop offset="0" stop-color="#ffffff"/><stop offset=".6" stop-color="#f1ece2"/><stop offset="1" stop-color="#d8d0c0"/></radialGradient>
    <linearGradient id="g-wood" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e2b46a"/><stop offset=".5" stop-color="#d9a85b"/><stop offset="1" stop-color="#cc9a4c"/></linearGradient>
    <filter id="f-grain" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.012 0.18" numOctaves="2" seed="7"/>
      <feColorMatrix values="0 0 0 0 0.42  0 0 0 0 0.27  0 0 0 0 0.12  0 0 0 0.10 0"/>
      <feComposite in2="SourceGraphic" operator="in"/>
    </filter>
    <filter id="f-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="1.2" dy="2" stdDeviation="1.4" flood-color="#3b250d" flood-opacity=".45"/></filter>`;
  el("rect", { width: 640, height: 640, rx: 10, fill: "url(#g-wood)" }, svg);
  el("rect", { width: 640, height: 640, rx: 10, fill: "#000", filter: "url(#f-grain)" }, svg);
  const grid = el("g", { stroke: "#6b4423", "stroke-width": 1.3, "stroke-linecap": "square" }, svg);
  for (let i = 0; i < SIZE; i++) {
    el("line", { x1: pos(0), y1: pos(i), x2: pos(SIZE - 1), y2: pos(i) }, grid);
    el("line", { x1: pos(i), y1: pos(0), x2: pos(i), y2: pos(SIZE - 1) }, grid);
  }
  el("rect", { x: pos(0), y: pos(0), width: pos(SIZE - 1) - M, height: pos(SIZE - 1) - M, fill: "none", stroke: "#6b4423", "stroke-width": 2.4 }, svg);
  for (const [x, y] of STARS) el("circle", { cx: pos(x), cy: pos(y), r: 4.2, fill: "#6b4423" }, svg);

  const marks = el("g", {}, svg);    // forbidden ×
  const stones = el("g", {}, svg);
  const top = el("g", { "pointer-events": "none" }, svg); // last move, win line, ghost, selection
  const coarse = matchMedia("(pointer: coarse)").matches;
  let state = { board: [], interactive: false, ghost: 1 };
  let hover = -1;

  function toIdx(evt) {
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    const x = Math.round((p.x - M) / STEP);
    const y = Math.round((p.y - M) / STEP);
    if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return -1;
    // ignore taps far from any intersection
    if (Math.hypot(p.x - pos(x), p.y - pos(y)) > STEP * 0.62) return -1;
    return y * SIZE + x;
  }

  svg.addEventListener("pointermove", (e) => {
    if (coarse || !state.interactive) return;
    const i = toIdx(e);
    if (i !== hover) {
      hover = i;
      drawTop();
    }
  });
  svg.addEventListener("pointerleave", () => {
    hover = -1;
    drawTop();
  });
  svg.addEventListener("click", (e) => {
    const i = toIdx(e);
    if (i >= 0) onPick(i, coarse);
  });

  function stone(idx, color, parent, extra = {}) {
    const x = pos(idx % SIZE);
    const y = pos(Math.floor(idx / SIZE));
    return el("circle", { cx: x, cy: y, r: STEP * 0.46, fill: color === 1 ? "url(#g-b)" : "url(#g-w)", filter: "url(#f-shadow)", ...extra }, parent);
  }

  function drawTop() {
    top.innerHTML = "";
    const { board, lastMove, winLine, selected, interactive, ghost } = state;
    if (lastMove != null && lastMove >= 0) {
      const x = pos(lastMove % SIZE);
      const y = pos(Math.floor(lastMove / SIZE));
      el("rect", { x: x - 5, y: y - 5, width: 10, height: 10, rx: 1.5, fill: "#b8322a" }, top);
    }
    if (winLine?.length) {
      const a = winLine[0];
      const b = winLine.at(-1);
      el("line", {
        x1: pos(a % SIZE), y1: pos(Math.floor(a / SIZE)), x2: pos(b % SIZE), y2: pos(Math.floor(b / SIZE)),
        stroke: "#b8322a", "stroke-width": 5, "stroke-linecap": "round", opacity: .85,
      }, top);
    }
    const show = selected >= 0 ? selected : interactive ? hover : -1;
    const banned = (state.forbidden ?? []).some((f) => f.idx === show);
    if (show >= 0 && board[show] === 0 && !banned) {
      stone(show, ghost, top, { opacity: selected >= 0 ? .8 : .45, filter: "" });
      if (selected >= 0) {
        const x = pos(show % SIZE);
        const y = pos(Math.floor(show / SIZE));
        const c = { stroke: "#b8322a", "stroke-width": 2, opacity: .9 };
        el("line", { x1: pos(0), y1: y, x2: pos(SIZE - 1), y2: y, ...c, opacity: .35 }, top);
        el("line", { x1: x, y1: pos(0), x2: x, y2: pos(SIZE - 1), ...c, opacity: .35 }, top);
        el("circle", { cx: x, cy: y, r: STEP * 0.52, fill: "none", ...c }, top);
      }
    }
  }

  return {
    /** state: { board, lastMove, winLine, forbidden:[{idx}], selected, interactive, ghost } */
    render(next) {
      state = { selected: -1, ...next };
      svg.classList.toggle("locked", !state.interactive);
      stones.innerHTML = "";
      state.board.forEach((c, i) => c && stone(i, c, stones));
      marks.innerHTML = "";
      for (const f of state.forbidden ?? []) {
        const x = pos(f.idx % SIZE);
        const y = pos(Math.floor(f.idx / SIZE));
        const d = STEP * 0.2;
        el("path", { d: `M${x - d} ${y - d}L${x + d} ${y + d}M${x + d} ${y - d}L${x - d} ${y + d}`, stroke: "#b8322a", "stroke-width": 3, "stroke-linecap": "round", opacity: .8 }, marks);
      }
      drawTop();
    },
  };
}

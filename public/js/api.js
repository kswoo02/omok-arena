// Thin client for /api. Identity is a random token kept in localStorage.
const KEY_ID = "omok:player";
const KEY_NAME = "omok:nickname";

function store(k, v) {
  try {
    if (v === undefined) return localStorage.getItem(k);
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    return null;
  }
  return v;
}

let memId = null;
export function playerId() {
  let id = store(KEY_ID) || memId;
  if (!id) {
    id = "p_" + (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, "");
    store(KEY_ID, id);
    memId = id;
  }
  return id;
}
export const nickname = (v) => (v === undefined ? store(KEY_NAME) : store(KEY_NAME, v));

export class ApiError extends Error {
  constructor(status, code, reason, extra = {}) {
    super(reason);
    this.status = status;
    this.code = code;
    this.room = extra.room ?? null;
  }
}

async function call(method, path, body) {
  let r;
  try {
    r = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "network", "서버에 연결하지 못했어요. 인터넷 연결을 확인해 주세요.");
  }
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(r.status, json.error?.code ?? "error", json.error?.reason ?? "요청을 처리하지 못했어요.", json.error ?? {});
  return json;
}

const me = () => ({ playerId: playerId(), nickname: nickname() });

export const api = {
  rooms: () => call("GET", "/api/rooms"),
  create: (name, rule, opts = {}) => call("POST", "/api/rooms", { ...me(), name, rule, ...opts }),
  room: (id) => call("GET", `/api/rooms/${id}?playerId=${encodeURIComponent(playerId())}`),
  join: (id, password) => call("POST", `/api/rooms/${id}/join`, { ...me(), ...(password ? { password } : {}) }),
  move: (id, idx) => call("POST", `/api/rooms/${id}/move`, { playerId: playerId(), idx }),
  resign: (id) => call("POST", `/api/rooms/${id}/resign`, { playerId: playerId() }),
  leave: (id) => call("POST", `/api/rooms/${id}/leave`, { playerId: playerId() }),
  rematch: (id) => call("POST", `/api/rooms/${id}/rematch`, { playerId: playerId() }),
  decline: (id) => call("POST", `/api/rooms/${id}/decline`, { playerId: playerId() }),
  kick: (id) => call("POST", `/api/rooms/${id}/kick`, { playerId: playerId() }),
  react: (id, emoji) => call("POST", `/api/rooms/${id}/react`, { ...me(), emoji }),
  ping: (id) => call("POST", `/api/rooms/${id}/ping`, me()),
  streamUrl: (id, v) => `/api/rooms/${id}/stream?playerId=${encodeURIComponent(playerId())}&v=${v}`,
};

// Local server: public/ as static files + /api/* through the same handler as Vercel.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import handler from "./api/index.js";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "public");
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

export function createApp() {
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) return handler(req, res);
    const page = url.pathname === "/" ? "/index.html" : url.pathname === "/admin" ? "/admin.html" : url.pathname;
    const rel = normalize(page).replace(/^(\.\.[/\\])+/, "");
    try {
      const data = await readFile(join(ROOT, rel));
      res.writeHead(200, { "Content-Type": TYPES[extname(rel)] || "application/octet-stream" });
      res.end(data);
    } catch {
      const data = await readFile(join(ROOT, "index.html"));
      res.writeHead(200, { "Content-Type": TYPES[".html"] });
      res.end(data);
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  createApp().listen(port, () => console.log(`수담 오목: http://localhost:${port}`));
}

// Tiny static server with cross-origin isolation (required for emscripten
// pthreads / SharedArrayBuffer). Serves examples/qemu-test/ by default.
//
//   node build/serve-coi.mjs [dir] [port]
//
// COEP=credentialless lets the page pull xterm from a CDN without CORP issues
// while still enabling crossOriginIsolated (Chrome).
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";

const root = process.argv[2] || "examples/qemu-test";
const port = Number(process.argv[3] || 8080);

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".css": "text/css",
  ".json": "application/json",
};

createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
  let file = normalize(join(root, urlPath === "/" ? "/index.html" : urlPath));
  if (!file.startsWith(normalize(root))) {
    res.writeHead(403).end("forbidden");
    return;
  }
  let st;
  try {
    st = statSync(file);
    if (st.isDirectory()) {
      file = join(file, "index.html");
      st = statSync(file);
    }
  } catch {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, {
    "Content-Type": MIME[extname(file)] || "application/octet-stream",
    "Content-Length": st.size,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "credentialless",
    "Cross-Origin-Resource-Policy": "cross-origin",
    "Cache-Control": "no-store",
  });
  createReadStream(file).pipe(res);
}).listen(port, () => {
  console.log(`serving ${root} at http://localhost:${port}  (cross-origin isolated)`);
});

import { defineConfig } from "vite";

// The agent runs native, but the bash sandbox (container2wasm + xterm-pty
// TtyServer) uses SharedArrayBuffer, which needs cross-origin isolation.
// COEP=credentialless lets the CDN xterm-pty scripts load without CORP.
const coiHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

export default defineConfig({
  server: { headers: coiHeaders },
  preview: { headers: coiHeaders },
  define: {
    "process.env": {},
    global: "globalThis",
  },
});

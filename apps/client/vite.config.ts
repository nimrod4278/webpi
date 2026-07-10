import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The agent runs native, but the bash sandbox (container2wasm + xterm-pty
// TtyServer) uses SharedArrayBuffer, which needs cross-origin isolation.
// COEP=credentialless lets the CDN xterm-pty scripts load without CORP.
const coiHeaders = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "credentialless",
};

// Honor a harness/hosting-assigned PORT (Vite doesn't read it by default) so the
// dev server can fall off an occupied port; otherwise Vite picks its own.
const port = process.env.PORT ? Number(process.env.PORT) : undefined;

export default defineConfig({
  plugins: [react()],
  server: { port, headers: coiHeaders },
  preview: { headers: coiHeaders },
  define: {
    "process.env": {},
    global: "globalThis",
  },
});

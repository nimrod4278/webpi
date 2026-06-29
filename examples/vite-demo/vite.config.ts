import { defineConfig } from "vite";

// Native browser agent — no emulation, no SharedArrayBuffer, so no special headers.
export default defineConfig({
  // Some provider SDKs reference `process`/`global`; shim for the browser.
  define: {
    "process.env": {},
    global: "globalThis",
  },
});

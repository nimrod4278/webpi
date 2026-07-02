/// <reference types="vite/client" />

// Vite serves the imported asset's URL (used for wllama's WASM binary).
declare module "*.wasm?url" {
  const url: string;
  export default url;
}

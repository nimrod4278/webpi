import type { Plugin } from "vite";
import fs from "node:fs/promises";
import path from "node:path";
import { fetchSandboxAssets, type FetchAssetsOptions } from "./fetch.js";

export { fetchSandboxAssets, type FetchAssetsOptions };

/**
 * Recursively scans a directory to check if the C2wSandbox is used in the codebase.
 */
async function checkSandboxUsage(dir: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // Skip common large directories to optimize scanning
        if (
          entry.name === "node_modules" ||
          entry.name === "dist" ||
          entry.name === ".git" ||
          entry.name === "public"
        ) {
          continue;
        }
        if (await checkSandboxUsage(fullPath)) {
          return true;
        }
      } else if (entry.isFile() && /\.(tsx?|jsx?|html)$/.test(entry.name)) {
        const content = await fs.readFile(fullPath, "utf8");
        // Look for imports or references to sandbox tools
        if (
          content.includes("@wepi/sdk/c2w") ||
          content.includes("useC2wSandbox") ||
          content.includes("C2wSandbox")
        ) {
          return true;
        }
      }
    }
  } catch (e) {
    // Gracefully handle file system read errors
  }
  return false;
}

/**
 * A Vite plugin that automatically downloads the container2wasm sandbox assets
 * (WASM emulators and Alpine image) to the public directory if the app uses C2wSandbox.
 */
export function wepiAssetsPlugin(opts: FetchAssetsOptions = {}): Plugin {
  let hasFetched = false;

  return {
    name: "vite-plugin-wepi-assets",
    async configResolved(config: any) {
      if (hasFetched) return;
      hasFetched = true;

      const targetDir = opts.targetDir || path.resolve(config.root, "public");

      // Scan src directory from Vite's root
      const srcDir = path.resolve(config.root, "src");
      const isSandboxUsed = await checkSandboxUsage(srcDir);

      if (!isSandboxUsed) {
        console.log("[wepi-assets-plugin] C2wSandbox usage not detected in src/. Skipping asset fetch.");
        return;
      }

      console.log("[wepi-assets-plugin] C2wSandbox detected. Preparing sandbox assets...");
      try {
        await fetchSandboxAssets({
          ...opts,
          targetDir,
        });
      } catch (err) {
        console.error("[wepi-assets-plugin] Failed to fetch sandbox assets:", err);
      }
    },
  };
}

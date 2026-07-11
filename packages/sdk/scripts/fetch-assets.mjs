#!/usr/bin/env node
/**
  * CLI tool to fetch container2wasm sandbox assets.
  * Delegated programmatically to dist/vite/fetch.js.
  */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchSandboxAssets } from "../dist/vite/fetch.js";

const args = process.argv.slice(2);
const flag = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
};
const has = (name) => args.includes(`--${name}`);

const targetDir = resolve(args.find((a) => !a.startsWith("--")) || join(process.cwd(), "public"));
const tag = flag("tag");
const repo = flag("repo");
const url = flag("url");
const force = has("force");

try {
  await fetchSandboxAssets({
    targetDir,
    tag,
    repo,
    url,
    force,
  });
} catch (err) {
  console.error("wepi-fetch-assets error:", err instanceof Error ? err.message : err);
  process.exit(1);
}

#!/usr/bin/env node
/**
 * Populate a directory with the container2wasm sandbox runtime assets that
 * `C2wSandbox` (packages/sdk/src/c2w/sandbox.ts) expects under `assetsBaseUrl`:
 *
 *     <targetDir>/out.wasm.gzip
 *     <targetDir>/imagemounter.wasm.gzip
 *     <targetDir>/worker.js
 *     <targetDir>/dist/{runcontainer,stack-worker,worker-util}.js
 *     <targetDir>/alpine/            (the prebuilt eStargz OCI rootfs)
 *
 * These are big (~30MB) and mostly vendored upstream blobs, so they don't ship
 * in the npm tarball. Instead we fetch a pinned release bundle on demand — run
 * this once (e.g. in the host app's `predev`) and point `assetsBaseUrl` at the
 * directory. To customize the rootfs, rebuild just the `alpine/` piece with
 * `wepi-build-image`.
 *
 * Usage:  wepi-fetch-assets [targetDir] [--tag=<release>] [--repo=owner/repo]
 *                           [--url=<tarball url>] [--force]
 *         defaults: targetDir ./public, tag v<sdk-version>, repo below.
 *
 * `--url` accepts any URL the runtime `fetch` understands (including a local
 * `file://` path), which is handy for testing before a release exists.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(HERE, "..", "package.json"), "utf8"));

// Optional pinned manifest: { "sha256": "...", "files": ["out.wasm.gzip", ...] }.
// Presence enables integrity + layout checks; absence just skips them.
const manifestPath = join(HERE, "assets-manifest.json");
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : { files: ["out.wasm.gzip", "imagemounter.wasm.gzip", "worker.js", "dist", "alpine"] };

const DEFAULT_REPO = "nimrod4278/webpi"; // override with --repo if the fork differs

const args = process.argv.slice(2);
const flag = (name) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : undefined;
};
const has = (name) => args.includes(`--${name}`);

const targetDir = resolve(args.find((a) => !a.startsWith("--")) || join(process.cwd(), "public"));
const tag = flag("tag") || `v${pkg.version}`;
const repo = flag("repo") || DEFAULT_REPO;
const bundle = `wepi-sandbox-assets-${tag.replace(/^v/, "")}.tar.gz`;
const url = flag("url") || `https://github.com/${repo}/releases/download/${tag}/${bundle}`;
const force = has("force");

const alreadyPopulated =
  existsSync(join(targetDir, "out.wasm.gzip")) && existsSync(join(targetDir, "alpine"));
if (alreadyPopulated && !force) {
  console.log(`wepi-fetch-assets: ${targetDir} already has sandbox assets; skipping (use --force to refetch).`);
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), "wepi-assets-"));
const tarPath = join(tmp, bundle);
try {
  // `file://` and bare local paths read from disk (offline / pre-release
  // testing); everything else goes over the network.
  const isLocal = url.startsWith("file://") || (!/^[a-z]+:\/\//i.test(url) && existsSync(url));
  let buf;
  if (isLocal) {
    const p = url.startsWith("file://") ? fileURLToPath(url) : url;
    console.log(`wepi-fetch-assets: reading ${p}`);
    buf = readFileSync(p);
  } else {
    console.log(`wepi-fetch-assets: downloading ${url}`);
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `download failed (${res.status} ${res.statusText}) for ${url}\n` +
          `Pass --url=<tarball> or --tag/--repo if the release lives elsewhere.`,
      );
    }
    buf = Buffer.from(await res.arrayBuffer());
  }

  if (manifest.sha256) {
    const got = createHash("sha256").update(buf).digest("hex");
    if (got !== manifest.sha256) {
      throw new Error(`checksum mismatch: expected ${manifest.sha256}, got ${got}`);
    }
    console.log("wepi-fetch-assets: checksum OK");
  }

  writeFileSync(tarPath, buf);
  mkdirSync(targetDir, { recursive: true });
  execFileSync("tar", ["-xzf", tarPath, "-C", targetDir], { stdio: "inherit" });

  const missing = (manifest.files ?? []).filter((f) => !existsSync(join(targetDir, f)));
  if (missing.length > 0) {
    throw new Error(`bundle extracted but missing expected entries: ${missing.join(", ")}`);
  }

  console.log(`wepi-fetch-assets: wrote sandbox assets to ${targetDir}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

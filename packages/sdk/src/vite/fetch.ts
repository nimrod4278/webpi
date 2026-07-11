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

const DEFAULT_REPO = "nimrod4278/webpi";

export interface FetchAssetsOptions {
  /**
   * Target directory where the sandbox assets will be downloaded and extracted.
   * Default: `./public` (resolved relative to current working directory).
   */
  targetDir?: string;
  /**
   * Release tag to download from (e.g. `v0.0.1`).
   * Default: `v<sdk-version>`.
   */
  tag?: string;
  /**
   * GitHub repository owner/name.
   * Default: `nimrod4278/webpi`.
   */
  repo?: string;
  /**
   * Override URL for the assets tarball.
   * Accepts standard URL protocols or a local file/path.
   */
  url?: string;
  /**
   * If true, force re-downloading and extracting the assets even if they are already present.
   * Default: `false`.
   */
  force?: boolean;
}

/**
 * Downloads and extracts the container2wasm Alpine VM and WASM assets.
 */
export async function fetchSandboxAssets(opts: FetchAssetsOptions = {}): Promise<void> {
  const HERE = dirname(fileURLToPath(import.meta.url));
  
  // Resolve package.json location relative to dist/vite/fetch.js
  const pkgPath = join(HERE, "..", "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));

  // Resolve manifest relative to dist/vite/fetch.js
  const manifestPath = join(HERE, "..", "..", "scripts", "assets-manifest.json");
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, "utf8"))
    : { files: ["out.wasm.gzip", "imagemounter.wasm.gzip", "worker.js", "dist", "alpine"] };

  const targetDir = resolve(opts.targetDir || join(process.cwd(), "public"));
  const tag = opts.tag || `v${pkg.version}`;
  const repo = opts.repo || DEFAULT_REPO;
  const bundle = `wepi-sandbox-assets-${tag.replace(/^v/, "")}.tar.gz`;
  const url = opts.url || `https://github.com/${repo}/releases/download/${tag}/${bundle}`;
  const force = opts.force ?? false;

  const alreadyPopulated =
    existsSync(join(targetDir, "out.wasm.gzip")) && existsSync(join(targetDir, "alpine"));
  if (alreadyPopulated && !force) {
    console.log(`wepi-fetch-assets: ${targetDir} already has sandbox assets; skipping (use --force to refetch).`);
    return;
  }

  const tmp = mkdtempSync(join(tmpdir(), "wepi-assets-"));
  const tarPath = join(tmp, bundle);
  try {
    const isLocal = url.startsWith("file://") || (!/^[a-z]+:\/\//i.test(url) && existsSync(url));
    let buf: Buffer;
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

    const missing = (manifest.files ?? []).filter((f: string) => !existsSync(join(targetDir, f)));
    if (missing.length > 0) {
      throw new Error(`bundle extracted but missing expected entries: ${missing.join(", ")}`);
    }

    console.log(`wepi-fetch-assets: wrote sandbox assets to ${targetDir}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

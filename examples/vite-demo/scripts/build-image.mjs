#!/usr/bin/env node
/**
 * Regenerate examples/vite-demo/public/alpine/ — the OCI image the bash sandbox mounts.
 *
 * WHY THIS IS NON-OBVIOUS (do not replace with a plain `docker pull`):
 *
 * The container2wasm emulator in `public/out.wasm.gzip` is a **riscv64** TinyEMU machine,
 * so the guest kernel can only exec **riscv64** binaries. A wrong-arch rootfs boots but then
 * fails every command with `exec /bin/sh: exec format error` (ENOEXEC) — which manifests as
 * the shell hanging forever, because the readiness/marker output never appears.
 *
 * Separately, the in-browser image mounter (go-containerregistry) hardcodes a default target
 * platform of **linux/amd64** and refuses to mount anything else ("manifest not found for
 * platform {amd64 linux}"). It only matches on the OCI index descriptor's `platform` field
 * and then extracts the layer tar as-is — it never checks that the binaries are actually amd64.
 *
 * So the working combination is: a **riscv64 rootfs** whose OCI index is **labeled amd64**.
 * The mounter is satisfied by the label; the riscv64 kernel happily execs the riscv64 binaries.
 *
 * Usage:  node scripts/build-image.mjs [outDir]   (default: ./public/alpine)
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = "library/alpine";
const TAG = "3.20";
const REG = "https://registry-1.docker.io";
const SRC_ARCH = "riscv64"; // must match the emulator (public/out.wasm.gzip)
const LABEL_ARCH = "amd64"; // must match the mounter's hardcoded default
const OUT = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), "..", "public", "alpine");

const token = (await (await fetch(
  `https://auth.docker.io/token?service=registry.docker.io&scope=repository:${REPO}:pull`,
)).json()).token;
const H = {
  Authorization: `Bearer ${token}`,
  Accept: [
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
  ].join(", "),
};
const get = async (url) => {
  const r = await fetch(url, { headers: H });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return Buffer.from(await r.arrayBuffer());
};

const idx = JSON.parse((await get(`${REG}/v2/${REPO}/manifests/${TAG}`)).toString());
const sel = idx.manifests.find((m) => m.platform?.architecture === SRC_ARCH && m.platform?.os === "linux");
if (!sel) throw new Error(`no ${SRC_ARCH} manifest for ${REPO}:${TAG}`);

const manBuf = await get(`${REG}/v2/${REPO}/manifests/${sel.digest}`);
const man = JSON.parse(manBuf.toString());

rmSync(OUT, { recursive: true, force: true });
const blobsDir = join(OUT, "blobs", "sha256");
mkdirSync(blobsDir, { recursive: true });
const writeBlob = (digest, buf) => writeFileSync(join(blobsDir, digest.split(":")[1]), buf);

writeBlob(man.config.digest, await get(`${REG}/v2/${REPO}/blobs/${man.config.digest}`));
for (const l of man.layers) writeBlob(l.digest, await get(`${REG}/v2/${REPO}/blobs/${l.digest}`));
writeBlob(sel.digest, manBuf);

writeFileSync(join(OUT, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
writeFileSync(
  join(OUT, "index.json"),
  JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        mediaType: man.mediaType || "application/vnd.oci.image.manifest.v1+json",
        digest: sel.digest,
        size: manBuf.length,
        platform: { architecture: LABEL_ARCH, os: "linux" }, // deliberately mislabeled; see header
      },
    ],
  }),
);
console.log(`Wrote ${OUT}: ${SRC_ARCH} rootfs, OCI index labeled ${LABEL_ARCH}.`);

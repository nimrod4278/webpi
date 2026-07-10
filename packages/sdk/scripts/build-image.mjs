#!/usr/bin/env node
/**
 * Regenerate apps/client/public/alpine/ — the OCI image the bash sandbox mounts.
 *
 * Builds scripts/sandbox.Dockerfile for linux/riscv64 (via Docker buildx + QEMU
 * binfmt) and exports it as an **eStargz** OCI layout. eStargz matters: the
 * in-browser imagemounter lazy-pulls eStargz layers chunk-by-chunk over HTTP
 * Range requests, so boot only downloads the few MB the shell actually touches
 * even though the image (python3 + nodejs + typescript) is ~10x bigger than the
 * bare Alpine it replaces. eStargz is still valid gzip, so if the server can't
 * do Range requests the mounter just downloads whole layers — slower first
 * load, same behavior.
 *
 * WHY THE INDEX IS MISLABELED (do not "fix" the amd64 platform field):
 *
 * The container2wasm emulator in `public/out.wasm.gzip` is a **riscv64** TinyEMU
 * machine, so the guest kernel can only exec **riscv64** binaries. A wrong-arch
 * rootfs boots but then fails every command with `exec format error`.
 *
 * Separately, the in-browser image mounter (go-containerregistry) hardcodes a
 * default target platform of **linux/amd64** and refuses to mount anything else.
 * It only matches on the OCI index descriptor's `platform` field and then
 * extracts the layer as-is — it never checks the binaries' actual arch.
 *
 * So the working combination is: a **riscv64 rootfs** whose OCI index is
 * **labeled amd64**. The mounter is satisfied by the label; the riscv64 kernel
 * happily execs the riscv64 binaries.
 *
 * Requires Docker Desktop (or any dockerd with binfmt riscv64 emulation).
 * A docker-container buildx builder is required for the eStargz OCI export;
 * the script creates one named `c2woci` if it doesn't exist.
 *
 * Usage:  wepi-build-image [outDir] [--arch=riscv64|amd64]
 *         (defaults: ./alpine in the current directory, riscv64)
 *
 * The built rootfs is one piece of the sandbox asset set consumed by
 * `C2wSandbox` (packages/sdk/src/c2w/sandbox.ts); `wepi-fetch-assets` pulls a
 * prebuilt copy of the whole set so most users never run this.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const archFlag = args.find((a) => a.startsWith("--arch="));
const SRC_ARCH = archFlag ? archFlag.split("=")[1] : "riscv64"; // must match the emulator (out.wasm.gzip)
const LABEL_ARCH = "amd64"; // must match the mounter's hardcoded default
const BUILDER = "c2woci";
const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(args.find((a) => !a.startsWith("--")) || join(process.cwd(), "alpine"));

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], ...opts });

// Ensure a docker-container builder (the default docker driver can't emit
// compression=estargz OCI output).
try {
  run("docker", ["buildx", "inspect", BUILDER]);
} catch {
  run("docker", ["buildx", "create", "--name", BUILDER, "--driver", "docker-container"]);
}

const tmp = mkdtempSync(join(tmpdir(), "wepi-oci-"));
const tarPath = join(tmp, "image.tar");
try {
  console.log(`Building ${SRC_ARCH} image (this runs apk/npm under QEMU — takes a few minutes)…`);
  run("docker", [
    "buildx", "build",
    "--builder", BUILDER,
    "--platform", `linux/${SRC_ARCH}`,
    "--provenance=false", // no attestation manifests in the index
    "-f", join(SCRIPTS, "sandbox.Dockerfile"),
    "--output", `type=oci,oci-mediatype=true,compression=estargz,force-compression=true,dest=${tarPath}`,
    SCRIPTS,
  ], { stdio: "inherit" });

  const layout = join(tmp, "layout");
  mkdirSync(layout, { recursive: true });
  run("tar", ["-xf", tarPath, "-C", layout]);

  // Resolve the image manifest descriptor: buildx may emit either a flat index
  // (descriptor -> image manifest) or a nested one (descriptor -> index).
  const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
  const blobPath = (digest) => join(layout, "blobs", "sha256", digest.split(":")[1]);
  let desc = readJson(join(layout, "index.json")).manifests[0];
  while (desc.mediaType.includes("index")) {
    const nested = readJson(blobPath(desc.digest)).manifests.filter(
      (m) => !m.annotations?.["vnd.docker.reference.type"], // skip attestations
    );
    desc = nested.find((m) => m.platform?.architecture === SRC_ARCH) ?? nested[0];
  }
  if (!desc) throw new Error("no image manifest found in buildx output");

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(dirname(OUT), { recursive: true });
  cpSync(join(layout, "blobs"), join(OUT, "blobs"), { recursive: true });
  writeFileSync(join(OUT, "oci-layout"), JSON.stringify({ imageLayoutVersion: "1.0.0" }));
  writeFileSync(
    join(OUT, "index.json"),
    JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        {
          mediaType: desc.mediaType,
          digest: desc.digest,
          size: desc.size,
          platform: { architecture: LABEL_ARCH, os: "linux" }, // deliberately mislabeled; see header
        },
      ],
    }),
  );
  console.log(`Wrote ${OUT}: ${SRC_ARCH} eStargz rootfs, OCI index labeled ${LABEL_ARCH}.`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

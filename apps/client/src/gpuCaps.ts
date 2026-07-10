/**
 * gpuCaps — best-effort probe of what this machine can run on-device, plus
 * classification of the GPU-loss failures that WebLLM surfaces when a model is
 * too heavy for the actual hardware.
 *
 * HONEST LIMITATION: WebGPU deliberately does not expose available VRAM. MLC's
 * `vram_required_MB` is a static estimate and there is NO browser API to verify
 * a GPU can allocate ~5 GB before you try. So this gate can only *reduce* the
 * chance of a device-loss (by refusing to offer a model whose required GPU
 * feature is missing, or whose buffer needs clearly exceed the adapter limits),
 * never guarantee it. Anything that slips through must fail gracefully — see
 * `isGpuLostError` and the recovery path in Workspace.tsx. The reliable default
 * is always the small wllama GGUF; the WebLLM 8B tier is opt-in.
 */

export interface GpuCaps {
  /** WebGPU adapter available (required for the WebLLM tier; speeds up wllama). */
  webgpu: boolean;
  /** `navigator.deviceMemory` in GB, if the browser reports it (Chrome caps at 8). */
  deviceMemoryGB?: number;
  /** Largest single GPU buffer the adapter allows, MB. */
  maxBufferMB?: number;
  /** `maxStorageBufferBindingSize`, MB — the limit MLC checks a model's buffers against. */
  maxStorageBufferMB?: number;
  /** Whether the adapter supports `shader-f16` — REQUIRED to run any q4f16 MLC model. */
  shaderF16: boolean;
}

interface GPUAdapterLike {
  features?: { has(name: string): boolean };
  limits?: { maxBufferSize?: number; maxStorageBufferBindingSize?: number };
}

export async function detectGpuCaps(): Promise<GpuCaps> {
  const nav = navigator as Navigator & {
    deviceMemory?: number;
    gpu?: { requestAdapter(): Promise<GPUAdapterLike | null> };
  };
  const deviceMemoryGB = typeof nav.deviceMemory === "number" ? nav.deviceMemory : undefined;
  try {
    const adapter = await nav.gpu?.requestAdapter();
    if (!adapter) return { webgpu: false, deviceMemoryGB, shaderF16: false };
    const mb = (bytes?: number) => (bytes ? Math.floor(bytes / 1e6) : undefined);
    return {
      webgpu: true,
      deviceMemoryGB,
      maxBufferMB: mb(adapter.limits?.maxBufferSize),
      maxStorageBufferMB: mb(adapter.limits?.maxStorageBufferBindingSize),
      shaderF16: adapter.features?.has("shader-f16") ?? false,
    };
  } catch {
    return { webgpu: false, deviceMemoryGB, shaderF16: false };
  }
}

/** What a WebLLM model needs from the GPU (for gating before we offer it). */
export interface GpuNeeds {
  /** MLC `vram_required_MB` — approximate working-set size. */
  vramMB: number;
  /** True for q4f16 builds: the GPU must support `shader-f16` or the model can't run at all. */
  requiresShaderF16: boolean;
}

/**
 * Can this machine PLAUSIBLY run a GPU-resident model of these needs? Deliberately
 * conservative — a false "no" costs the user a stronger model, but a false "yes"
 * costs them a mid-analysis GPU crash. `shader-f16` is a hard requirement (its
 * absence is a definite no); the rest is a heuristic since VRAM is unknowable.
 */
export function fitsGpu(caps: GpuCaps, needs: GpuNeeds): boolean {
  if (!caps.webgpu) return false;
  if (needs.requiresShaderF16 && !caps.shaderF16) return false;
  // A model's largest weight/KV buffer must fit maxStorageBufferBindingSize.
  // MLC reports these ~1–2 GB on capable GPUs; weak/old adapters report the
  // 128–256 MB spec minimum, which can't hold an 8B layer.
  if (caps.maxStorageBufferMB !== undefined && caps.maxStorageBufferMB < 1000) return false;
  if (caps.maxBufferMB !== undefined && caps.maxBufferMB < 1500) return false;
  // System RAM is a weak upper bound (unified memory on Macs). Chrome clamps
  // deviceMemory to 8 = "8 or more"; require the model to fit in ~⅔ of it.
  if (caps.deviceMemoryGB !== undefined && needs.vramMB > (caps.deviceMemoryGB * 1024 * 2) / 3) return false;
  return true;
}

/**
 * Does this error mean the WebGPU device was lost (OOM / GPU constraints)? WebLLM
 * surfaces this as several different messages across its async internals; the
 * engine is dead afterward and must be recreated (MLC's documented contract), so
 * the only recovery is to dispose and send the user back to model selection.
 */
export function isGpuLostError(error: unknown): boolean {
  const msg = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase();
  return (
    msg.includes("device was lost") ||
    msg.includes("devicelost") ||
    msg.includes("external instance reference") ||
    msg.includes("instance dropped") ||
    msg.includes("gpudevicelost")
  );
}

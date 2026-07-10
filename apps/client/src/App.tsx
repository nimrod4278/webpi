/**
 * Insight — a private, on-device data-dashboard builder, built on the `wepi` SDK.
 *
 * Drop a CSV → the pi agent analyses it with real Python in an in-browser
 * sandbox, finds insights, and writes a self-contained interactive dashboard
 * that renders live beside the chat. By default the model runs on-device over
 * WebGPU, so the data never leaves the browser; a cloud API key is an opt-in
 * escape hatch for harder datasets.
 *
 * This file is just the router between three screens; each screen is its own
 * module. It replaces the SDK's old two-demo showcase.
 */

import { useState } from "react";
import { Dropzone } from "./Dropzone";
import { ModelSetup, type ModelChoice } from "./ModelSetup";
import { Workspace } from "./Workspace";
import { rememberDataset, type Dataset } from "./lib";
import "./app.css";

export function App() {
  const [dataset, setDataset] = useState<Dataset | undefined>();
  // The model choice carries a live engine/Provider (not serialisable), so it
  // lives for the session and is reused across datasets until "change model".
  const [choice, setChoice] = useState<ModelChoice | undefined>();

  const pick = (d: Dataset) => {
    rememberDataset(d);
    setDataset(d);
  };

  // Free the old engine's WASM/GPU memory when the user swaps models — a
  // leaked 1.6–5 GB resident is how the tab used to OOM. Unmounting Workspace
  // aborts the in-flight turn first (usePiChat cleanup); the async dispose
  // then unloads the engine. Deliberately NOT done on "change dataset": the
  // model is reused across datasets.
  const changeModel = () => {
    const old = choice;
    setChoice(undefined);
    void old?.dispose?.().catch(() => {});
  };

  if (!dataset) {
    return <Dropzone onPick={pick} />;
  }
  if (!choice) {
    return (
      <div className="setup-screen">
        <button className="btn-ghost setup-back" onClick={() => setDataset(undefined)}>
          ← Datasets
        </button>
        <ModelSetup onReady={setChoice} />
      </div>
    );
  }
  return (
    <Workspace
      key={dataset.id}
      dataset={dataset}
      choice={choice}
      onChangeDataset={() => setDataset(undefined)}
      onChangeModel={changeModel}
    />
  );
}

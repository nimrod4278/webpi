/**
 * Home — the landing screen. Drag-drop or pick a CSV, try the bundled sample,
 * or reopen a recent dataset. Emits the chosen {@link Dataset} to the parent,
 * which routes to model setup (first run) then the workspace.
 *
 * Recent datasets carry only metadata; the CSV itself is restored from the
 * chat's IndexedDB snapshot in the workspace, so a recent entry hands back the
 * id/name and lets `persist` rehydrate the rest.
 */

import { useRef, useState } from "react";
import { datasetFromFile, loadComplexSampleDataset, loadRecents, SAMPLE_DATASET, type Dataset } from "../lib";

export function Home({ onPick }: { onPick: (d: Dataset) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [loadingComplex, setLoadingComplex] = useState(false);
  const recents = loadRecents();

  const handleComplexSample = async () => {
    setError(undefined);
    setLoadingComplex(true);
    try {
      onPick(await loadComplexSampleDataset());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingComplex(false);
    }
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    setError(undefined);
    if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") {
      setError("Please choose a .csv file.");
      return;
    }
    try {
      onPick(await datasetFromFile(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="home">
      <header className="home-head">
        <h1 className="brand">Insight</h1>
        <p className="tagline">
          Drop a spreadsheet. Get an interactive dashboard. <strong>Your data never leaves your browser.</strong>
        </p>
      </header>

      <div
        className={"dropzone" + (dragOver ? " dropzone-over" : "")}
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void handleFile(e.dataTransfer.files[0]);
        }}
      >
        <div className="dropzone-icon">⬆️</div>
        <p className="dropzone-title">Drop a CSV here, or click to browse</p>
        <p className="muted small">Sales exports, survey results, transactions, logs — anything tabular.</p>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={(e) => void handleFile(e.target.files?.[0])}
        />
      </div>

      {error && <p className="error">{error}</p>}

      <div className="home-actions">
        <button className="btn-ghost" onClick={() => onPick(SAMPLE_DATASET)}>
          ✨ Try a sample dataset
        </button>
        <button className="btn-ghost" onClick={() => void handleComplexSample()} disabled={loadingComplex}>
          {loadingComplex ? "Loading…" : "🧾 Try a complex sample (500-row orders)"}
        </button>
      </div>

      {recents.length > 0 && (
        <div className="recents">
          <h3 className="recents-title">Recent</h3>
          <ul className="recents-list">
            {recents.map((r) => (
              <li key={r.id}>
                <button className="recent-item" onClick={() => onPick({ id: r.id, name: r.name, text: "" })}>
                  <span className="recent-name">{r.name}</span>
                  <span className="muted small">{new Date(r.openedAt).toLocaleDateString()}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="muted small">Recents reopen from on-device storage. A file with no saved analysis will start fresh.</p>
        </div>
      )}

      <footer className="home-foot muted small">
        Runs the pi coding agent natively in your browser — real Python analysis in a sandbox, powered by the{" "}
        <code>wepi</code> SDK. No backend.
      </footer>
    </div>
  );
}

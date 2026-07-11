/**
 * Dataset plumbing for the CSV → dashboard app: reading a picked file, deriving
 * a stable per-dataset id (so `persist` can resume the exact analysis), and a
 * tiny "recent datasets" registry backed by localStorage. Kept framework-free.
 */

/** A dataset the user chose to analyse. `text` is the raw CSV contents. */
export interface Dataset {
  /** Stable id derived from name+size — also the `persist` id for the chat. */
  id: string;
  name: string;
  text: string;
}

/** Rough guardrail: the workspace holds string contents, so keep CSVs sane. */
export const MAX_CSV_BYTES = 8 * 1024 * 1024; // 8 MB

/** Read a picked File as UTF-8 text (browsers decode text files as UTF-8). */
export function readFileText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("failed to read file"));
    reader.readAsText(file);
  });
}

/** Stable, collision-resistant-enough id from name + byte length (FNV-1a). */
export function datasetId(name: string, byteLength: number): string {
  let h = 0x811c9dc5;
  const key = `${name}:${byteLength}`;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return "ds_" + (h >>> 0).toString(36);
}

/** Build a Dataset from a picked File (throws on oversize). */
export async function datasetFromFile(file: File): Promise<Dataset> {
  if (file.size > MAX_CSV_BYTES) {
    throw new Error(
      `That file is ${(file.size / 1e6).toFixed(1)} MB. Please pick a CSV under ${MAX_CSV_BYTES / 1e6} MB.`,
    );
  }
  const text = await readFileText(file);
  return { id: datasetId(file.name, file.size), name: file.name, text };
}

// ── recent datasets (metadata only; the CSV lives in the chat's IndexedDB snapshot) ──

export interface RecentDataset {
  id: string;
  name: string;
  openedAt: number;
}

const RECENTS_KEY = "insight.recents.v1";
const MAX_RECENTS = 8;

export function loadRecents(): RecentDataset[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    const list = raw ? (JSON.parse(raw) as RecentDataset[]) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function rememberDataset(d: Pick<Dataset, "id" | "name">): void {
  const list = loadRecents().filter((r) => r.id !== d.id);
  list.unshift({ id: d.id, name: d.name, openedAt: Date.now() });
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, MAX_RECENTS)));
  } catch {
    /* storage full / disabled — recents are best-effort */
  }
}

/** A small, insight-rich sample so first-time users can try it in one click. */
export const SAMPLE_CSV = `date,region,category,units,revenue
2024-01-05,North,Widgets,120,3600
2024-01-18,South,Gadgets,80,4000
2024-02-02,North,Widgets,95,2850
2024-02-14,East,Gizmos,60,5400
2024-02-27,West,Gadgets,140,7000
2024-03-09,South,Widgets,110,3300
2024-03-22,North,Gizmos,45,4050
2024-04-03,East,Gadgets,160,8000
2024-04-19,West,Widgets,130,3900
2024-05-01,South,Gizmos,70,6300
2024-05-16,North,Gadgets,150,7500
2024-05-30,East,Widgets,100,3000
2024-06-11,West,Gizmos,55,4950
2024-06-24,South,Gadgets,175,8750
2024-07-07,North,Widgets,90,2700
2024-07-21,East,Gizmos,80,7200
2024-08-04,West,Gadgets,190,9500
2024-08-19,South,Widgets,105,3150
2024-09-02,North,Gizmos,65,5850
2024-09-15,East,Gadgets,210,10500
`;

export const SAMPLE_DATASET: Dataset = {
  id: datasetId("sample-sales.csv", SAMPLE_CSV.length),
  name: "sample-sales.csv",
  text: SAMPLE_CSV,
};

/**
 * A second, meatier sample (500 rows, 25 columns of e-commerce orders) served
 * from `public/data.csv`. Unlike {@link SAMPLE_DATASET} this one is fetched
 * lazily instead of inlined, since it's too large to ship in the JS bundle.
 */
export const COMPLEX_SAMPLE_META = { name: "orders-sample.csv", url: "/data.csv" };

export async function loadComplexSampleDataset(): Promise<Dataset> {
  const res = await fetch(COMPLEX_SAMPLE_META.url);
  if (!res.ok) throw new Error(`Failed to load sample dataset (${res.status}).`);
  const text = await res.text();
  return { id: datasetId(COMPLEX_SAMPLE_META.name, text.length), name: COMPLEX_SAMPLE_META.name, text };
}

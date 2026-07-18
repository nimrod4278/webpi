/**
 * FileExplorer — a live view of the agent's virtual workspace.
 *
 * The pi agent doesn't just emit the final dashboard: it writes Python scripts,
 * intermediate data, and other files into `chat.fs` as it works. This pane makes
 * that visible — a file tree on the left (folders collapse, freshly-written files
 * flash), a content viewer on the right — so the user can actually see what the
 * agent created. It subscribes to `chat.fs.onChange`, so files stream in live as
 * the agent works; nothing here polls.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import type { Chat } from "@wepi/sdk";

// ── tree model ──────────────────────────────────────────────────────────────

interface FileLeaf {
  type: "file";
  name: string;
  path: string; // full workspace-relative path
  size: number; // bytes (UTF-16 length is close enough for a hint)
}
interface DirNode {
  type: "dir";
  name: string;
  path: string;
  children: TreeNode[];
}
type TreeNode = DirNode | FileLeaf;

/** Turn a flat {path: content} map into a nested, sorted tree. */
function buildTree(files: Record<string, string>): DirNode {
  const root: DirNode = { type: "dir", name: "", path: "", children: [] };
  for (const path of Object.keys(files)) {
    const parts = path.split("/").filter(Boolean);
    let dir = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const full = parts.slice(0, i + 1).join("/");
      if (i === parts.length - 1) {
        dir.children.push({ type: "file", name, path: full, size: files[path].length });
      } else {
        let next = dir.children.find((c) => c.type === "dir" && c.name === name) as DirNode | undefined;
        if (!next) {
          next = { type: "dir", name, path: full, children: [] };
          dir.children.push(next);
        }
        dir = next;
      }
    }
  }
  // Sort each level: folders first, then files, alphabetically.
  const sort = (node: DirNode) => {
    node.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach((c) => c.type === "dir" && sort(c));
  };
  sort(root);
  return root;
}

/** Pick a file to show first: prefer the dashboard, else any html, else first. */
function pickDefault(files: Record<string, string>): string | undefined {
  const paths = Object.keys(files).sort();
  if (paths.length === 0) return undefined;
  return (
    paths.find((p) => p.toLowerCase().endsWith("dashboard.html")) ??
    paths.find((p) => p.toLowerCase().endsWith(".html")) ??
    paths[0]
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function fileIcon(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "html":
      return "🌐";
    case "py":
      return "🐍";
    case "csv":
    case "tsv":
      return "📈";
    case "json":
      return "🧾";
    case "md":
      return "📝";
    case "txt":
      return "📄";
    case "png":
    case "jpg":
    case "jpeg":
    case "svg":
      return "🖼️";
    default:
      return "📄";
  }
}

// ── component ────────────────────────────────────────────────────────────────

export function FileExplorer({ chat }: { chat: Chat | undefined }) {
  const [files, setFiles] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState<string | undefined>();
  const [recent, setRecent] = useState<Set<string>>(new Set());
  // Whether the user has explicitly picked a file — if not, we auto-follow the
  // most recently written file so the pane always shows the latest activity.
  const pinnedRef = useRef(false);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    if (!chat) return;
    const initial = chat.files();
    setFiles(initial);
    // Seed a selection from files that already exist (e.g. the input dataset, or
    // a restored session) — later writes auto-follow unless the user pins one.
    setSelected((cur) => cur ?? pickDefault(initial));
    const unsub = chat.fs.onChange((change) => {
      setFiles((prev) => ({ ...prev, [change.path]: change.content }));
      // Flash the row that just changed, then clear it after the animation.
      setRecent((prev) => new Set(prev).add(change.path));
      const existing = timers.current.get(change.path);
      if (existing) clearTimeout(existing);
      timers.current.set(
        change.path,
        setTimeout(() => {
          setRecent((prev) => {
            const next = new Set(prev);
            next.delete(change.path);
            return next;
          });
          timers.current.delete(change.path);
        }, 1400),
      );
      // Follow the newest write unless the user pinned a selection.
      if (!pinnedRef.current) setSelected(change.path);
    });
    return () => {
      unsub();
      timers.current.forEach(clearTimeout);
      timers.current.clear();
    };
  }, [chat]);

  const tree = useMemo(() => buildTree(files), [files]);
  const paths = Object.keys(files);
  const totalBytes = useMemo(() => paths.reduce((sum, p) => sum + files[p].length, 0), [files, paths]);

  const pick = (path: string) => {
    pinnedRef.current = true;
    setSelected(path);
  };

  const selectedContent = selected != null ? files[selected] : undefined;

  const download = () => {
    if (selected == null || selectedContent == null) return;
    const blob = new Blob([selectedContent], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = selected.split("/").pop() || "file.txt";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="files">
      <div className="files-bar">
        <span className="files-summary">
          {paths.length === 0
            ? "No files yet"
            : `${paths.length} file${paths.length === 1 ? "" : "s"} · ${fmtBytes(totalBytes)}`}
        </span>
        <button className="btn-ghost" onClick={download} disabled={selected == null}>
          Download
        </button>
      </div>

      <div className="files-body">
        <div className="files-tree">
          {paths.length === 0 ? (
            <div className="files-empty muted small">The agent's files will appear here as it works.</div>
          ) : (
            <TreeLevel node={tree} depth={0} selected={selected} recent={recent} onPick={pick} />
          )}
        </div>

        <div className="files-viewer">
          {selectedContent != null ? (
            <>
              <div className="viewer-path">
                <span className="viewer-icon">{fileIcon(selected!)}</span>
                <span className="viewer-name">{selected}</span>
                <span className="viewer-meta muted small">
                  {selectedContent.split("\n").length} lines · {fmtBytes(selectedContent.length)}
                </span>
              </div>
              <pre className="viewer-code">
                <code>{selectedContent}</code>
              </pre>
            </>
          ) : (
            <div className="files-empty muted">Select a file to view its contents.</div>
          )}
        </div>
      </div>
    </section>
  );
}

/** Render one directory's children, recursing into subfolders. */
function TreeLevel({
  node,
  depth,
  selected,
  recent,
  onPick,
}: {
  node: DirNode;
  depth: number;
  selected: string | undefined;
  recent: Set<string>;
  onPick: (path: string) => void;
}) {
  return (
    <>
      {node.children.map((child) =>
        child.type === "dir" ? (
          <Folder key={child.path} node={child} depth={depth} selected={selected} recent={recent} onPick={onPick} />
        ) : (
          <button
            key={child.path}
            className={
              "tree-row tree-file" +
              (selected === child.path ? " tree-row-selected" : "") +
              (recent.has(child.path) ? " tree-row-changed" : "")
            }
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => onPick(child.path)}
            title={child.path}
          >
            <span className="tree-icon">{fileIcon(child.name)}</span>
            <span className="tree-name">{child.name}</span>
            <span className="tree-size muted">{fmtBytes(child.size)}</span>
          </button>
        ),
      )}
    </>
  );
}

function Folder({
  node,
  depth,
  selected,
  recent,
  onPick,
}: {
  node: DirNode;
  depth: number;
  selected: string | undefined;
  recent: Set<string>;
  onPick: (path: string) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button
        className="tree-row tree-folder"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => setOpen((o) => !o)}
        title={node.path}
      >
        <span className="tree-twisty">{open ? "▾" : "▸"}</span>
        <span className="tree-icon">{open ? "📂" : "📁"}</span>
        <span className="tree-name">{node.name}</span>
      </button>
      {open && (
        <TreeLevel node={node} depth={depth + 1} selected={selected} recent={recent} onPick={onPick} />
      )}
    </>
  );
}

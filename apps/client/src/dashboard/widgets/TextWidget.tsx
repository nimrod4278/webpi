/**
 * A written insight from the agent. Renders light markdown — headings (#),
 * bullet lines (-/*), and **bold** — without pulling in a markdown dependency.
 */

import { Fragment, type ReactNode } from "react";
import type { Widget } from "../types";

/** Split a line on **bold** spans. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={i}>{part.slice(2, -2)}</strong> : <Fragment key={i}>{part}</Fragment>,
  );
}

export function TextWidget({ widget }: { widget: Extract<Widget, { kind: "text" }> }) {
  const lines = widget.markdown.split("\n");
  return (
    <div className="w-text">
      {lines.map((raw, i) => {
        const line = raw.trim();
        if (!line) return <div key={i} className="w-text-gap" />;
        if (line.startsWith("#")) return <h3 key={i}>{inline(line.replace(/^#+\s*/, ""))}</h3>;
        if (/^[-*]\s+/.test(line)) return <li key={i}>{inline(line.replace(/^[-*]\s+/, ""))}</li>;
        return <p key={i}>{inline(line)}</p>;
      })}
    </div>
  );
}

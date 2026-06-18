import { useMemo, useState } from "react";
import type { CallNode } from "../../shared/types.js";
import { waterfallByClass } from "../lib/tree.js";
import { fmtDuration } from "../lib/format.js";

const DEFAULT_LIMIT = 14;

export function Waterfall({
  root,
  baseline,
  total,
  selId,
  onSelect,
}: {
  root: CallNode;
  baseline: number;
  total: number;
  selId: string | null;
  onSelect: (id: string) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(() => waterfallByClass(root), [root]);
  const shown = showAll ? rows : rows.slice(0, DEFAULT_LIMIT);

  // Color a bar by share of total self-time (heat), or violet for managed pkg.
  const barColor = (selfNanos: number, isManaged: boolean, hasError: boolean) => {
    if (hasError) return "linear-gradient(90deg,var(--heat2),var(--heat3))";
    if (isManaged) return "linear-gradient(90deg,rgba(183,140,255,.85),rgba(155,140,255,.85))";
    const r = selfNanos / total;
    if (r > 0.35) return "linear-gradient(90deg,var(--heat2),var(--heat3))";
    if (r > 0.12) return "linear-gradient(90deg,var(--heat1),var(--heat2))";
    return "linear-gradient(90deg,var(--soql),var(--mth))";
  };

  return (
    <div className="wf">
      {shown.map((r) => {
        const left = ((r.startNanos - baseline) / total) * 100;
        const width = Math.max(0.6, ((r.endNanos - r.startNanos) / total) * 100);
        const selfPct = ((r.selfNanos / total) * 100).toFixed(0);
        return (
          <div
            key={`${r.namespace}|${r.className}`}
            className={`wf-row ${r.firstNodeId === selId ? "sel" : ""}`}
            onClick={() => onSelect(r.firstNodeId)}
            title={`${r.className} · ${r.calls} call${r.calls === 1 ? "" : "s"} · self ${fmtDuration(r.selfNanos)} (${selfPct}%)`}
          >
            <div className="wf-label">
              {r.isManaged && <span className="wf-lock">🔒</span>}
              <span className={`wf-name ${r.isManaged ? "mp" : ""}`}>{r.className}</span>
              {r.calls > 1 && <span className="wf-calls">×{r.calls}</span>}
            </div>
            <div className="wf-track">
              <span className="wf-bar" style={{ left: `${left}%`, width: `${width}%`, background: barColor(r.selfNanos, r.isManaged, r.hasError) }} />
            </div>
            <div className="wf-dur">{fmtDuration(r.selfNanos)}</div>
          </div>
        );
      })}
      {rows.length > DEFAULT_LIMIT && (
        <button className="wf-more" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "show top 14" : `show all ${rows.length} classes`}
        </button>
      )}
    </div>
  );
}

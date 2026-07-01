import { useLayoutEffect, useMemo, useRef } from "react";
import type { CallNode } from "../../shared/types.js";
import { chipFor, meaningfulValues, subtreeTouches } from "../lib/tree.js";
import { fmtDuration } from "../lib/format.js";

interface Props {
  root: CallNode;
  total: number;
  selId: string | null;
  query: string;
  pathOnly: boolean;
  expandAll: boolean;
  openIds: Set<string>;
  revealKey: number;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void;
  onFocusClass: (cls: string) => void;
}

function heat(dur: number | null, total: number): string {
  if (dur === null) return "var(--heat1)";
  const r = dur / total;
  return r > 0.35 ? "var(--heat3)" : r > 0.12 ? "var(--heat2)" : "var(--heat1)";
}

function matches(n: CallNode, q: string): boolean {
  if (!q) return true;
  const hay = `${n.className ?? ""} ${n.method ?? ""} ${n.query ?? ""} ${n.exceptionType ?? ""}`.toLowerCase();
  return hay.includes(q);
}

export function TraceTree(props: Props) {
  const { root, query } = props;
  const q = query.trim().toLowerCase();
  const treeRef = useRef<HTMLDivElement>(null);

  // Whether a node should appear given the path-only + search filters.
  const visibleDeep = useMemo(() => {
    const cache = new Map<string, boolean>();
    const fn = (n: CallNode): boolean => {
      if (cache.has(n.id)) return cache.get(n.id)!;
      const selfOk = (!props.pathOnly || n.onPath) && matches(n, q);
      const childOk = n.children.some(fn);
      const r = selfOk || childOk;
      cache.set(n.id, r);
      return r;
    };
    return fn;
  }, [props.pathOnly, q, root]);

  useLayoutEffect(() => {
    if (!props.selId || props.revealKey === 0) return;
    const selectedRow = treeRef.current?.querySelector<HTMLElement>(".row.sel");
    selectedRow?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [props.revealKey, props.selId]);

  return (
    <div className="tree" role="tree" ref={treeRef}>
      {visibleDeep(root) ? (
        <Row {...props} node={root} q={q} visibleDeep={visibleDeep} heatTotal={props.total} />
      ) : (
        <div className="empty">
          Nothing matches that filter.
          <br />
          Try a class name.
        </div>
      )}
    </div>
  );
}

function Row({
  node,
  total,
  selId,
  q,
  pathOnly,
  expandAll,
  openIds,
  revealKey,
  onToggle,
  onSelect,
  onFocusClass,
  visibleDeep,
  heatTotal,
}: Props & { node: CallNode; q: string; visibleDeep: (n: CallNode) => boolean; heatTotal: number }) {
  const leaf = node.children.length === 0;
  const isOpen = expandAll || openIds.has(node.id) || (!!q && node.children.some(visibleDeep));
  const isMP = node.kind === "managed-pkg";
  const touches = node.kind === "method" && !leaf ? subtreeTouches(node, 2) : { names: [], total: 0 };
  const valCount = meaningfulValues(node).length;

  return (
    <div className="node">
      <div
        className={`row ${node.onPath ? "onpath" : ""} ${node.id === selId ? "sel" : ""} ${isMP ? "mp" : ""}`}
        role="treeitem"
        tabIndex={0}
        onClick={() => onSelect(node.id)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), onSelect(node.id))}
      >
        <span
          className={`chev ${leaf ? "leaf" : ""} ${isOpen ? "open" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            if (!leaf) onToggle(node.id);
          }}
        >
          ▶
        </span>
        <span className={`chip ${chipFor(node)}`}>{isMP ? "🔒" : chipFor(node)}</span>
        <span className="lbl">{labelEl(node)}</span>
        <span className="badges">
          {touches.names.length > 0 && (
            <span className="bdg touch" title={`touches ${touches.names.join(", ")}`}>
              {touches.names[0]}
              {touches.total > 1 ? ` +${touches.total - 1}` : ""}
            </span>
          )}
          {valCount > 0 && <span className="bdg">{valCount} val</span>}
          {node.rows != null && <span className="bdg rows">{node.rows} row{node.rows === 1 ? "" : "s"}</span>}
          {node.line != null && <span className="bdg">L{node.line}</span>}
          {node.className && (
            <button
              className="bdg focusbtn"
              title={`focus on ${node.className}`}
              onClick={(e) => { e.stopPropagation(); onFocusClass(node.className!); }}
            >
              ◎ focus
            </button>
          )}
        </span>
        <span className="dur">
          <span className="ms">{fmtDuration(node.durationNanos)}</span>
          <span className="hbar">
            <i
              style={{
                width: `${Math.max(4, Math.round(((node.durationNanos ?? 0) / total) * 100))}%`,
                background: node.kind === "exception" ? "var(--ember)" : heat(node.durationNanos, heatTotal),
              }}
            />
          </span>
        </span>
      </div>
      {!leaf && isOpen && (
        <div className="kids">
          {node.children.filter(visibleDeep).map((c) => (
            <Row
              key={c.id}
              {...{ total, selId, q, pathOnly, expandAll, openIds, revealKey, onToggle, onSelect, onFocusClass, visibleDeep, heatTotal }}
              root={node}
              query={q}
              node={c}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function labelEl(n: CallNode) {
  if (n.kind === "soql")
    return <span className="qtxt" title={n.query}>{n.query}</span>;
  if (n.kind === "exception")
    return (
      <>
        <span className="xtxt">{n.exceptionType}</span>
        <span className="note">{n.exceptionMessage}</span>
      </>
    );
  if (n.kind === "managed-pkg")
    return (
      <>
        <span className="mp-badge">managed package</span>
        <span className="mp-ns">{n.namespace}</span>
        <span className="note">· ×{n.suppressedCount ?? 0} statements hidden</span>
      </>
    );
  if (n.kind === "root") return <span className="mth">{n.method}</span>;
  if (n.kind === "dml") return <span className="mth">{n.method}</span>;
  return (
    <>
      {n.className && <span className="cls">{n.className}</span>}
      {n.className && n.method && <span className="dot">.</span>}
      <span className="mth">{n.method}</span>
    </>
  );
}

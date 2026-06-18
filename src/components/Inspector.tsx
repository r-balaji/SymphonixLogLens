import { useEffect, useState } from "react";
import type { CallNode } from "../../shared/types.js";
import { indexTree, label, meaningfulValues, pathTo } from "../lib/tree.js";
import { classifyValue, fmtDuration, maybePretty } from "../lib/format.js";
import { fetchSource } from "../lib/api.js";

type Tab = "vars" | "src" | "raw";

interface Props {
  root: CallNode;
  selId: string | null;
  total: number;
  onSelect: (id: string) => void;
  onTrack: (name: string) => void;
  onFocusClass: (cls: string) => void;
}

export function Inspector({ root, selId, total, onSelect, onTrack, onFocusClass }: Props) {
  const idx = indexTree(root);
  const node = selId ? idx.byId.get(selId) ?? null : null;
  const [tab, setTab] = useState<Tab>("vars");

  useEffect(() => {
    // Land on the most useful tab for the selection.
    if (node?.kind === "exception") setTab(node.sourceUrl ? "src" : "vars");
  }, [selId]);

  if (!node) {
    return (
      <aside className="insp">
        <div className="ibody">
          <div className="empty">
            Select a frame in the call tree or timeline.
            <br />
            <br />
            Tip — <b style={{ color: "var(--ember)" }}>Trace to exception</b> drops you on the failing line.
          </div>
        </div>
      </aside>
    );
  }

  const path = pathTo(idx, node.id);
  const vals = meaningfulValues(node);
  const hasSrc = !!node.sourceUrl;
  const hasRaw = (node.rawLines?.length ?? 0) > 0;

  return (
    <aside className="insp">
      <div className="crumbs">
        {path.map((c, i) => (
          <span key={c.id} style={{ display: "inline-flex", alignItems: "center" }}>
            <span className={`c ${i === path.length - 1 ? "last" : ""}`} onClick={() => onSelect(c.id)}>
              {label(c)}
            </span>
            {i < path.length - 1 && <span className="sep">→</span>}
          </span>
        ))}
      </div>

      <div className="sig">
        <h2>{titleEl(node)}</h2>
        <div className="meta">
          {node.startNanos !== null && <span>at <b>{fmtDuration((node.startNanos ?? 0))}</b></span>}
          {node.durationNanos !== null && (
            <span>took <b>{fmtDuration(node.durationNanos)}</b> ({(((node.durationNanos ?? 0) / total) * 100).toFixed(1)}%)</span>
          )}
          {node.line != null && <span>line <b>{node.line}</b></span>}
          {node.rows != null && <span>rows <b>{node.rows}</b></span>}
          {node.kind === "managed-pkg" && <span style={{ color: "var(--ext)" }}>external package — opaque frame</span>}
          {node.onPath && <span style={{ color: "var(--ember)" }}>on exception path</span>}
        </div>
        {(hasSrc || node.className) && (
          <div className="acts">
            {hasSrc && <button className="btn" onClick={() => setTab("src")}>open source</button>}
            {node.className && (
              <button className="btn" onClick={() => onFocusClass(node.className!)}>◎ focus {node.className}</button>
            )}
          </div>
        )}
      </div>

      <div className="tabs">
        <button className={`tab ${tab === "vars" ? "on" : ""}`} onClick={() => setTab("vars")}>
          Values{vals.length > 0 && <span className="n">{vals.length}</span>}
        </button>
        <button className={`tab ${tab === "src" ? "on" : ""}`} onClick={() => setTab("src")}>
          Source{hasSrc && <span className="n">1</span>}
        </button>
        <button className={`tab ${tab === "raw" ? "on" : ""}`} onClick={() => setTab("raw")}>
          Raw log{hasRaw && <span className="n">{node.rawLines!.length}</span>}
        </button>
      </div>

      <div className="ibody">
        {node.kind === "exception" && <ExceptionCard node={node} />}
        {tab === "vars" && <VarsTab node={node} onTrack={onTrack} />}
        {tab === "src" && <SourceTab node={node} />}
        {tab === "raw" && <RawTab node={node} />}
      </div>
    </aside>
  );
}

function titleEl(n: CallNode) {
  if (n.kind === "soql") return <>SOQL query</>;
  if (n.kind === "exception") return <>{n.exceptionType}</>;
  if (n.kind === "managed-pkg") return <><span className="cls">{n.namespace}</span> (managed)</>;
  if (n.kind === "root" || n.kind === "dml") return <>{n.method}</>;
  return (
    <>
      {n.className && <span className="cls">{n.className}</span>}
      {n.className && "."}
      {n.method}
    </>
  );
}

function ExceptionCard({ node }: { node: CallNode }) {
  return (
    <div className="xcard">
      <div className="xtype">✸ {node.exceptionType}</div>
      <div className="xmsg">{node.exceptionMessage}</div>
      {node.stack && node.stack.length > 0 && (
        <div className="xloc" style={{ marginTop: 10 }}>
          Stack (innermost first)
          {node.stack.map((s, i) => (
            <div key={i} style={{ padding: "2px 0", color: "var(--text)" }}>↳ {s}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function VarsTab({ node, onTrack }: { node: CallNode; onTrack: (n: string) => void }) {
  const vals = meaningfulValues(node);
  if (node.kind === "managed-pkg") {
    const io = [...(node.inputs ?? []), ...(node.outputs ?? [])];
    if (io.length === 0)
      return <div className="empty">Entered {node.namespace} — no boundary values logged.</div>;
  }
  if (vals.length === 0) return <div className="empty">No variable assignments captured for this frame.</div>;
  return (
    <table className="vars">
      <thead>
        <tr><th>Name</th><th>Value at this frame</th></tr>
      </thead>
      <tbody>
        {vals.map((v, i) => (
          <tr key={i}>
            <td className="vn"><button onClick={() => onTrack(v.name)} title="track across the run">{v.name}</button></td>
            <td className="vv"><ValueCell value={v.value} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ValueCell({ value }: { value: string }) {
  const [open, setOpen] = useState(false);
  const shape = classifyValue(value);
  if (shape.kind === "object" || shape.kind === "array") {
    return (
      <>
        <span className="jsonbtn" onClick={() => setOpen((o) => !o)}>
          {shape.summary} {open ? "▾" : "▸"}
        </span>
        {open && <pre>{maybePretty(value)}</pre>}
      </>
    );
  }
  if (shape.kind === "null") return <span className="null">null</span>;
  if (shape.kind === "string") return <span className="str">"{shape.text}"</span>;
  if (shape.kind === "number") return <span className="num">{shape.text}</span>;
  return <>{shape.kind === "bool" || shape.kind === "raw" ? shape.text : value}</>;
}

function SourceTab({ node }: { node: CallNode }) {
  const [data, setData] = useState<{ path: string; methodLine: number | null; content: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setData(null);
    setErr(null);
    if (node.sourceUrl) fetchSource(node.sourceUrl).then(setData).catch((e) => setErr((e as Error).message));
  }, [node.id]);

  if (!node.sourceUrl)
    return (
      <div className="empty">
        No matching file in the connected repo for this frame
        {node.kind === "managed-pkg" ? " — it lives in another managed package" : ""}.
        <br /><br />Connect your SFDX repo in the header to enable source.
      </div>
    );
  if (err) return <div className="empty err">{err}</div>;
  if (!data) return <div className="empty">loading source…</div>;

  const lines = data.content.split(/\r?\n/);
  const hot = node.line ?? data.methodLine;
  return (
    <div className="src">
      <div className="srchead">📄 {data.path}<span className="repo">⎇ connected repo</span></div>
      <div className="src-lines">
        {lines.map((l, i) => {
          const n = i + 1;
          const isHot = n === hot;
          return (
            <div
              key={i}
              className={`codeln ${isHot ? "hl" : ""}`}
              ref={isHot ? (el) => el?.scrollIntoView({ block: "center" }) : undefined}
            >
              <span className="ln">{n}</span>
              <pre>{l || " "}</pre>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RawTab({ node }: { node: CallNode }) {
  if (!node.rawLines?.length) return <div className="empty">Raw lines for this frame are not captured.</div>;
  return (
    <div className="raw">
      {node.rawLines.map((l, i) => (
        <div key={i} className="ll">{l}</div>
      ))}
    </div>
  );
}

import { useMemo } from "react";
import type { DiagnosisFinding, FindingSeverity } from "../../shared/types.js";

interface Props {
  findings: DiagnosisFinding[];
  open: boolean;
  onToggle: () => void;
  onSelectNode: (id: string) => void;
  onFocusClass: (className: string) => void;
  onTrack: (name: string) => void;
  onOpenWaterfall: () => void;
}

export function DiagnosisPanel({
  findings,
  open,
  onToggle,
  onSelectNode,
  onFocusClass,
  onTrack,
  onOpenWaterfall,
}: Props) {
  const counts = useMemo(() => countFindings(findings), [findings]);
  const top = findings[0] ?? null;
  const status = top
    ? top.severity === "critical"
      ? "Failed"
      : top.severity === "warning"
        ? "Needs attention"
        : "Informational"
    : "No findings";

  return (
    <section className="diagwrap">
      <div className="diaghead">
        <button className="flametgl" onClick={onToggle}>{open ? "-" : "+"}</button>
        <span className="t">Findings / Diagnosis</span>
        <span className={`diagstatus ${top?.severity ?? "info"}`}>{status}</span>
        <span className="ticks">
          {findings.length === 0
            ? "no rule-based findings"
            : `${counts.critical} critical · ${counts.warning} warning · ${counts.info} info`}
        </span>
      </div>

      {open && (
        findings.length === 0 ? (
          <div className="diagempty">
            No diagnosis rules fired for this log. Use the tree, values, and waterfall for manual inspection.
          </div>
        ) : (
          <div className="diaggrid">
            {findings.map((finding) => (
              <FindingCard
                key={finding.id}
                finding={finding}
                onSelectNode={onSelectNode}
                onFocusClass={onFocusClass}
                onTrack={onTrack}
                onOpenWaterfall={onOpenWaterfall}
              />
            ))}
          </div>
        )
      )}
    </section>
  );
}

function FindingCard({
  finding,
  onSelectNode,
  onFocusClass,
  onTrack,
  onOpenWaterfall,
}: {
  finding: DiagnosisFinding;
  onSelectNode: (id: string) => void;
  onFocusClass: (className: string) => void;
  onTrack: (name: string) => void;
  onOpenWaterfall: () => void;
}) {
  const copy = () => {
    void navigator.clipboard?.writeText(formatFinding(finding));
  };

  return (
    <article className={`diagcard ${finding.severity}`}>
      <div className="diagcard-top">
        <span className={`diagsev ${finding.severity}`}>{finding.severity}</span>
        <span className="diagcat">{labelCategory(finding.category)}</span>
      </div>
      <h3>{finding.title}</h3>
      <div className="diagloc">{finding.location}</div>
      <p>{finding.summary}</p>
      <div className="diagwhy">
        <b>Why</b>
        <span>{finding.rootCause}</span>
      </div>
      <div className="diagev">
        {finding.evidence.slice(0, 4).map((item, i) => (
          <div key={i}>{item}</div>
        ))}
      </div>
      <div className="diagfix">
        <b>Fix</b>
        <span>{finding.recommendation}</span>
      </div>
      <div className="diagverify">
        <b>Verify</b>
        <span>{finding.verify}</span>
      </div>
      <div className="diagacts">
        {finding.nodeId && <button className="btn" onClick={() => onSelectNode(finding.nodeId!)}>Trace</button>}
        {finding.focusClass && <button className="btn" onClick={() => onFocusClass(finding.focusClass!)}>Focus</button>}
        {finding.trackValue && <button className="btn" onClick={() => onTrack(finding.trackValue!)}>Track value</button>}
        {(finding.category === "performance" || finding.category === "governor-limit") && (
          <button className="btn" onClick={onOpenWaterfall}>Waterfall</button>
        )}
        <button className="btn" onClick={copy}>Copy</button>
      </div>
    </article>
  );
}

function countFindings(findings: DiagnosisFinding[]): Record<FindingSeverity, number> {
  return findings.reduce<Record<FindingSeverity, number>>(
    (acc, finding) => {
      acc[finding.severity] += 1;
      return acc;
    },
    { critical: 0, warning: 0, info: 0 },
  );
}

function labelCategory(category: DiagnosisFinding["category"]): string {
  switch (category) {
    case "governor-limit": return "Limit";
    case "repeated-soql": return "SOQL";
    case "repeated-dml": return "DML";
    case "large-query": return "Query";
    case "managed-package": return "Managed package";
    default: return category;
  }
}

function formatFinding(finding: DiagnosisFinding): string {
  return [
    `Issue: ${finding.title}`,
    `Location: ${finding.location}`,
    `Root cause: ${finding.rootCause}`,
    `Severity: ${finding.severity}`,
    `Fix: ${finding.recommendation}`,
    `Verify: ${finding.verify}`,
    "Evidence:",
    ...finding.evidence.map((item) => `- ${item}`),
  ].join("\n");
}

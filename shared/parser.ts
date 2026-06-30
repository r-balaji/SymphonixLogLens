import type {
  CallNode,
  DiagnosisFinding,
  DebugEntry,
  ExecContext,
  FindingSeverity,
  LimitRow,
  LimitsSummary,
  LimitUsage,
  ParseOptions,
  ParseResult,
  ValueAssignment,
} from "./types.js";

/**
 * Salesforce FINEST debug log parser.
 *
 * One streaming pass over the lines builds a call tree of home-namespace methods
 * and constructors, with VARIABLE_ASSIGNMENT values and USER_DEBUG messages
 * attached to whichever node is executing. Runs of ENTERING_MANAGED_PKG markers
 * in a foreign namespace are folded into a single "black box" node whose inputs
 * and outputs are the assignments that bracket the run.
 *
 * Line grammar (validated against real Q2 lending logs):
 *   header:  "<ver> APEX_CODE,FINEST;..."
 *   event:   "HH:MM:SS.mmm (nanos)|EVENT_TYPE|...payload"
 * Values never wrap to a second physical line.
 */

const LINE_RE = /^(\d{2}:\d{2}:\d{2}\.\d+)\s+\((\d+)\)\|([A-Z_]+)\|(.*)$/s;

let idCounter = 0;
function nextId(): string {
  return `n${(idCounter++).toString(36)}`;
}

function parseLineNo(field: string): number | null {
  // field looks like "[439]" or "[EXTERNAL]"
  const m = /^\[(\d+)\]$/.exec(field);
  return m ? Number(m[1]) : null;
}

/** Split "ns.Class.method(args)" / "<init>(args)" into parts. */
function parseSignature(sig: string): {
  namespace: string | null;
  className: string | null;
  method: string | null;
} {
  // Strip the (args) for name analysis, keep sig intact elsewhere.
  const nameOnly = sig.replace(/\(.*\)\s*$/s, "");
  if (nameOnly.startsWith("<init>")) {
    return { namespace: null, className: null, method: "<init>" };
  }
  const parts = nameOnly.split(".");
  if (parts.length >= 3) {
    return {
      namespace: parts[0],
      className: parts[1],
      method: parts.slice(2).join("."),
    };
  }
  if (parts.length === 2) {
    return { namespace: null, className: parts[0], method: parts[1] };
  }
  return { namespace: null, className: nameOnly || null, method: null };
}

/** "ns.Class" form (the METHOD_EXIT / CONSTRUCTOR payload tail). */
function parseClassRef(ref: string): {
  namespace: string | null;
  className: string | null;
} {
  const parts = ref.split(".");
  if (parts.length >= 2) {
    return { namespace: parts[0], className: parts.slice(1).join(".") };
  }
  return { namespace: null, className: ref || null };
}

function makeNode(kind: CallNode["kind"]): CallNode {
  return {
    id: nextId(),
    kind,
    namespace: null,
    className: null,
    method: null,
    signature: null,
    classId: null,
    line: null,
    startNanos: null,
    endNanos: null,
    selfNanos: null,
    durationNanos: null,
    assignments: [],
    debugs: [],
    children: [],
  };
}

export function parseLog(text: string, opts: ParseOptions): ParseResult {
  idCounter = 0;
  const home = opts.homeNamespace.trim();
  const lines = text.split(/\r?\n/);
  const warnings: string[] = [];
  const events: Record<string, number> = {};

  // Header
  let apiVersion = "";
  let logLevels = "";
  const firstNonEmpty = lines.find((l) => l.trim().length > 0) ?? "";
  const headerMatch = /^(\d+\.\d+)\s+(.*)$/.exec(firstNonEmpty);
  if (headerMatch) {
    apiVersion = headerMatch[1];
    logLevels = headerMatch[2];
  } else {
    warnings.push("Could not parse the header line for API version / log levels.");
  }

  const root = makeNode("root");
  root.method = "Execution";
  const stack: CallNode[] = [root];
  const top = () => stack[stack.length - 1];

  let user: string | null = null;
  const foreignSet = new Set<string>();
  let methodCalls = 0;
  let managedPkgRuns = 0;
  let soqlCount = 0;
  let dmlCount = 0;
  let soqlRows = 0;
  let dmlRows = 0;
  let codeUnit: string | null = null;
  let exceptionNode: CallNode | null = null;
  const limits: LimitUsage[] = [];
  // Set when a code-unit label hints at an async entry point (Queueable, Batch, …).
  let asyncLabel: string | null = null;

  // Pending managed-package run state. We fold consecutive ENTERING_MANAGED_PKG
  // markers (same namespace, uninterrupted by a real method event) into one node.
  let pendingMP: CallNode | null = null;
  // The last few assignments seen on the current node, used as MP "inputs".
  let recentAssignments: ValueAssignment[] = [];

  const closeMP = () => {
    pendingMP = null;
  };

  // Keep a small ring of recent raw lines so a frame can show its boundary lines.
  const recentRaw: string[] = [];
  const pushRaw = (line: string) => {
    recentRaw.push(line);
    if (recentRaw.length > 4) recentRaw.shift();
  };
  const attachRaw = (node: CallNode, line: string) => {
    node.rawLines = node.rawLines ?? [];
    if (node.rawLines.length < 8) node.rawLines.push(line);
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (!raw) continue;
    const m = LINE_RE.exec(raw);
    if (!m) {
      // Header line or an unrecognized continuation; skip quietly.
      continue;
    }
    const [, , nanosStr, type, payload] = m;
    const nanos = Number(nanosStr);
    events[type] = (events[type] ?? 0) + 1;
    pushRaw(raw);

    switch (type) {
      case "USER_INFO": {
        // [EXTERNAL]|005...|email|timezone...
        const parts = payload.split("|");
        user = parts[2] ?? user;
        break;
      }

      case "CODE_UNIT_STARTED": {
        closeMP();
        // [EXTERNAL]|id|label   OR  [EXTERNAL]|label
        const parts = payload.split("|");
        const label = parts[parts.length - 1];
        if (codeUnit === null) codeUnit = label;
        if (asyncLabel === null) asyncLabel = asyncHintFromLabel(label);
        const unit = makeNode("method");
        unit.method = label;
        unit.signature = label;
        unit.startNanos = nanos;
        unit.line = parseLineNo(parts[0]);
        attachRaw(unit, raw);
        top().children.push(unit);
        stack.push(unit);
        recentAssignments = [];
        break;
      }

      case "CODE_UNIT_FINISHED": {
        closeMP();
        const node = top();
        if (node !== root) {
          node.endNanos = nanos;
          stack.pop();
        }
        break;
      }

      case "METHOD_ENTRY":
      case "CONSTRUCTOR_ENTRY": {
        closeMP();
        // METHOD_ENTRY:      [line]|classId|ns.Class.method(args)
        // CONSTRUCTOR_ENTRY: [line]|classId|<init>(args)|ns.Class
        const parts = payload.split("|");
        const lineNo = parseLineNo(parts[0]);
        const classId = parts[1] ?? null;
        let sig: string;
        let ns: string | null;
        let className: string | null;
        let method: string | null;
        if (type === "CONSTRUCTOR_ENTRY") {
          sig = parts[2] ?? "";
          const ref = parseClassRef(parts[3] ?? "");
          ns = ref.namespace;
          className = ref.className;
          method = "<init>";
        } else {
          sig = parts[2] ?? "";
          const p = parseSignature(sig);
          ns = p.namespace;
          className = p.className;
          method = p.method;
        }

        const node = makeNode(type === "CONSTRUCTOR_ENTRY" ? "constructor" : "method");
        node.namespace = ns;
        node.className = className;
        node.method = method;
        node.signature = sig;
        node.classId = classId;
        node.line = lineNo;
        node.startNanos = nanos;
        attachRaw(node, raw);
        top().children.push(node);
        stack.push(node);
        methodCalls++;
        // Note: a foreign-namespace method entry (ns !== home) is the named
        // entry point; its internals arrive as ENTERING_MANAGED_PKG children.
        // The UI shows that signature, which is the real "what was called".
        recentAssignments = [];
        break;
      }

      case "METHOD_EXIT":
      case "CONSTRUCTOR_EXIT": {
        closeMP();
        const node = top();
        if (node !== root) {
          node.endNanos = nanos;
          stack.pop();
        }
        recentAssignments = [];
        break;
      }

      case "ENTERING_MANAGED_PKG": {
        const ns = payload.trim();
        if (ns && ns !== home) foreignSet.add(ns);

        // Fold consecutive markers of the same namespace into one black box.
        if (pendingMP && pendingMP.namespace === ns) {
          pendingMP.suppressedCount = (pendingMP.suppressedCount ?? 0) + 1;
          pendingMP.endNanos = nanos;
        } else {
          const mp = makeNode("managed-pkg");
          mp.namespace = ns;
          mp.method = `Managed package: ${ns}`;
          mp.startNanos = nanos;
          mp.endNanos = nanos;
          mp.suppressedCount = 1;
          // Inputs: the assignments we just saw on the home side.
          mp.inputs = recentAssignments.slice(-6);
          mp.outputs = [];
          top().children.push(mp);
          pendingMP = mp;
          managedPkgRuns++;
        }
        break;
      }

      case "VARIABLE_ASSIGNMENT": {
        // [line]|name|value|heapRef?   (heapRef optional; value may contain no extra '|')
        const parts = payload.split("|");
        const lineNo = parseLineNo(parts[0]);
        const name = parts[1] ?? "";
        const value = parts[2] ?? "";
        const va: ValueAssignment = { line: lineNo, name, value };

        if (pendingMP) {
          // First assignments after a MP run are its outputs.
          pendingMP.outputs = pendingMP.outputs ?? [];
          if (pendingMP.outputs.length < 6) pendingMP.outputs.push(va);
        }
        top().assignments.push(va);
        recentAssignments.push(va);
        if (recentAssignments.length > 12) recentAssignments.shift();
        break;
      }

      case "USER_DEBUG": {
        // [line]|LEVEL|message
        const parts = payload.split("|");
        const d: DebugEntry = {
          line: parseLineNo(parts[0]),
          level: parts[1] ?? "DEBUG",
          message: parts.slice(2).join("|"),
        };
        top().debugs.push(d);
        break;
      }

      case "SOQL_EXECUTE_BEGIN": {
        closeMP();
        // [line]|Aggregations:N|<query>
        const parts = payload.split("|");
        const node = makeNode("soql");
        node.line = parseLineNo(parts[0]);
        node.query = parts.slice(2).join("|");
        node.method = "SOQL";
        node.startNanos = nanos;
        attachRaw(node, raw);
        top().children.push(node);
        stack.push(node);
        soqlCount++;
        break;
      }
      case "SOQL_EXECUTE_END": {
        // [line]|Rows:N
        const parts = payload.split("|");
        const node = top();
        if (node.kind === "soql") {
          const rm = /Rows:(\d+)/.exec(parts[1] ?? "");
          node.rows = rm ? Number(rm[1]) : null;
          if (rm) soqlRows += Number(rm[1]);
          node.endNanos = nanos;
          stack.pop();
        }
        break;
      }

      case "DML_BEGIN": {
        closeMP();
        // [line]|Op:Insert|Type:Account|Rows:N
        const parts = payload.split("|");
        const node = makeNode("dml");
        node.line = parseLineNo(parts[0]);
        node.dmlOp = (/Op:(\w+)/.exec(parts[1] ?? "") ?? [])[1] ?? "DML";
        const typeM = /Type:([\w.]+)/.exec(parts[2] ?? "");
        node.className = typeM ? typeM[1] : null;
        const rowM = /Rows:(\d+)/.exec(parts[3] ?? "");
        node.rows = rowM ? Number(rowM[1]) : null;
        if (rowM) dmlRows += Number(rowM[1]);
        node.method = `${node.dmlOp} ${node.className ?? ""}`.trim();
        node.startNanos = nanos;
        attachRaw(node, raw);
        top().children.push(node);
        stack.push(node);
        dmlCount++;
        break;
      }
      case "DML_END": {
        const node = top();
        if (node.kind === "dml") {
          node.endNanos = nanos;
          stack.pop();
        }
        break;
      }

      case "EXCEPTION_THROWN": {
        // [line]|ExceptionType: message
        const parts = payload.split("|");
        const lineNo = parseLineNo(parts[0]);
        const detail = parts.slice(1).join("|");
        const colon = detail.indexOf(":");
        const node = makeNode("exception");
        node.line = lineNo;
        node.exceptionType = colon >= 0 ? detail.slice(0, colon).trim() : detail.trim();
        node.exceptionMessage = colon >= 0 ? detail.slice(colon + 1).trim() : "";
        node.method = node.exceptionType;
        node.startNanos = nanos;
        node.endNanos = nanos;
        attachRaw(node, raw);
        // Capture the live call stack (class.method of each open frame).
        node.stack = stack
          .filter((s) => s.kind !== "root")
          .map((s) => `${s.className ?? ""}${s.method ? "." + s.method : ""}${s.line ? " — line " + s.line : ""}`)
          .reverse();
        top().children.push(node);
        exceptionNode = node;
        // Mark the whole open stack as on-path.
        for (const s of stack) s.onPath = true;
        node.onPath = true;
        break;
      }
      case "FATAL_ERROR": {
        // Attach the formatted stack to the exception node if we have one.
        if (exceptionNode && !exceptionNode.exceptionMessage) {
          exceptionNode.exceptionMessage = payload.split("\n")[0] ?? payload;
        }
        break;
      }

      case "CUMULATIVE_LIMIT_USAGE":
      case "LIMIT_USAGE_FOR_NS": {
        // Lines like "  Number of SOQL queries: 4 out of 100" follow on
        // subsequent physical lines; capture from the recent raw ring.
        // The "  Number of X: N out of M" detail lines FOLLOW this event line
        // and are indented continuations that don't match LINE_RE — scan forward
        // until the next real event line.
        for (let j = i + 1; j < lines.length; j++) {
          const dl = lines[j];
          if (LINE_RE.test(dl)) break; // next event begins
          const lm = /Number of ([\w ]+?):\s*(\d+) out of (\d+)/.exec(dl) ||
            /Maximum ([\w ]+?):\s*(\d+) out of (\d+)/.exec(dl);
          if (lm) {
            const key = lm[1].trim();
            const used = Number(lm[2]);
            const max = Number(lm[3]);
            const existing = limits.find((x) => x.key === key);
            // Limit blocks repeat per code-unit boundary; keep the PEAK usage,
            // which is what governs whether the transaction hit a cap.
            if (!existing) limits.push({ key, used, max });
            else if (used > existing.used) existing.used = used;
          }
        }
        break;
      }

      // Noise we deliberately ignore for the tree (counts only):
      case "STATEMENT_EXECUTE":
      case "HEAP_ALLOCATE":
      case "VARIABLE_SCOPE_BEGIN":
      case "SYSTEM_METHOD_ENTRY":
      case "SYSTEM_METHOD_EXIT":
      default:
        break;
    }
  }

  // Close any nodes left open (truncated logs).
  if (stack.length > 1) {
    warnings.push(
      `${stack.length - 1} call(s) were still open at end of log (log may be truncated).`,
    );
  }

  computeTiming(root);

  const baselineNanos = firstStart(root);
  const durationNanos =
    root.children.length > 0
      ? lastEnd(root) !== null && baselineNanos !== null
        ? (lastEnd(root) as number) - baselineNanos
        : null
      : null;

  const limitsSummary = buildLimitsSummary(limits, asyncLabel, {
    soqlCount,
    soqlRows,
    dmlCount,
    dmlRows,
    soslCount: events["SOSL_EXECUTE_BEGIN"] ?? 0,
    calloutCount: events["CALLOUT_REQUEST"] ?? 0,
  });

  const findings = buildDiagnosisFindings(root, exceptionNode, limitsSummary, {
    durationNanos,
    limitsAreLogged: limits.length > 0,
    managedPkgRuns,
    warnings,
  });

  return {
    apiVersion,
    logLevels,
    user,
    codeUnit,
    root,
    limits,
    limitsSummary,
    exception: exceptionNode,
    findings,
    warnings,
    stats: {
      totalLines: lines.length,
      events,
      homeNamespace: home,
      foreignNamespaces: [...foreignSet].sort(),
      methodCalls,
      managedPkgRuns,
      soqlCount,
      dmlCount,
      durationNanos,
      baselineNanos,
      hasSoql: soqlCount > 0,
      hasDml: dmlCount > 0,
      hasLimits: limits.length > 0,
      hasException: exceptionNode !== null,
    },
  };
}

// --- Governor limits -------------------------------------------------------

// Standard per-transaction caps used when the log has no CUMULATIVE_LIMIT_USAGE
// (i.e. APEX_PROFILING was off) so we can still estimate from counted events.
// Only SOQL queries and CPU differ between sync/async; the rest are shared.
const STD_CAPS = {
  soqlSync: 100,
  soqlAsync: 200,
  soqlRows: 50000,
  dml: 150,
  dmlRows: 10000,
  sosl: 20,
  callouts: 100,
};

interface CountedEvents {
  soqlCount: number;
  soqlRows: number;
  dmlCount: number;
  dmlRows: number;
  soslCount: number;
  calloutCount: number;
}

/** Returns an async context label if the code-unit label hints at one. */
function asyncHintFromLabel(label: string): string | null {
  const l = label.toLowerCase();
  if (/queueable/.test(l)) return "Asynchronous (Queueable)";
  if (/\bbatch/.test(l)) return "Asynchronous (Batch)";
  if (/future/.test(l)) return "Asynchronous (@future)";
  if (/schedul/.test(l)) return "Asynchronous (Scheduled)";
  return null;
}

/** Strip the "Number of " / "Maximum " prefix and tidy a logged limit key. */
function prettyLimitKey(k: string): string {
  const s = k.replace(/^Number of /i, "").replace(/^Maximum /i, "");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function buildLimitsSummary(
  limits: LimitUsage[],
  asyncLabel: string | null,
  counts: CountedEvents,
): LimitsSummary {
  // Context: the logged SOQL cap is the most reliable signal (100 sync / 200 async),
  // then the code-unit label hint, else assume synchronous.
  const soqlLimit = limits.find((l) => /SOQL queries/i.test(l.key));
  let context: ExecContext;
  let contextLabel: string;
  if (soqlLimit?.max === 200) {
    context = "async";
    contextLabel = asyncLabel ?? "Asynchronous";
  } else if (soqlLimit?.max === 100) {
    context = "sync";
    contextLabel = "Synchronous";
  } else if (asyncLabel) {
    context = "async";
    contextLabel = asyncLabel;
  } else {
    context = "sync";
    contextLabel = "Synchronous (assumed)";
  }

  if (limits.length > 0) {
    const rows: LimitRow[] = limits
      .filter((l) => l.max > 0)
      .map((l) => ({ key: prettyLimitKey(l.key), used: l.used, max: l.max }))
      .sort((a, b) => b.used / b.max - a.used / a.max);
    return { context, contextLabel, source: "logged", rows };
  }

  // No logged limits — estimate from every limit-relevant event we counted.
  const soqlMax = context === "async" ? STD_CAPS.soqlAsync : STD_CAPS.soqlSync;
  const rows: LimitRow[] = [
    { key: "SOQL queries", used: counts.soqlCount, max: soqlMax },
    { key: "Query rows", used: counts.soqlRows, max: STD_CAPS.soqlRows },
    { key: "DML statements", used: counts.dmlCount, max: STD_CAPS.dml },
    { key: "DML rows", used: counts.dmlRows, max: STD_CAPS.dmlRows },
    { key: "SOSL queries", used: counts.soslCount, max: STD_CAPS.sosl },
    { key: "Callouts", used: counts.calloutCount, max: STD_CAPS.callouts },
  ];
  return { context, contextLabel, source: "estimated", rows };
}

function firstStart(node: CallNode): number | null {
  if (node.startNanos !== null) return node.startNanos;
  for (const c of node.children) {
    const s = firstStart(c);
    if (s !== null) return s;
  }
  return null;
}

function lastEnd(node: CallNode): number | null {
  let end = node.endNanos;
  for (const c of node.children) {
    const e = lastEnd(c);
    if (e !== null && (end === null || e > end)) end = e;
  }
  return end;
}

/** Fill duration and self-time bottom-up. */
function computeTiming(node: CallNode): void {
  for (const c of node.children) computeTiming(c);
  if (node.startNanos !== null && node.endNanos !== null) {
    node.durationNanos = node.endNanos - node.startNanos;
  }
  const childTotal = node.children.reduce(
    (acc, c) => acc + (c.durationNanos ?? 0),
    0,
  );
  if (node.durationNanos !== null) {
    node.selfNanos = Math.max(0, node.durationNanos - childTotal);
  }
}

// --- Diagnosis findings ----------------------------------------------------

interface DiagnosisContext {
  durationNanos: number | null;
  limitsAreLogged: boolean;
  managedPkgRuns: number;
  warnings: string[];
}

interface NodeIndex {
  nodes: CallNode[];
  parent: Map<string, CallNode | null>;
}

function buildDiagnosisFindings(
  root: CallNode,
  exceptionNode: CallNode | null,
  limitsSummary: LimitsSummary,
  ctx: DiagnosisContext,
): DiagnosisFinding[] {
  const idx = flattenWithParents(root);
  const findings: DiagnosisFinding[] = [];

  addExceptionFinding(findings, exceptionNode, idx);
  addLimitFindings(findings, limitsSummary, root);
  addRepeatedSoqlFindings(findings, idx);
  addRepeatedDmlFindings(findings, idx);
  addLargeQueryFindings(findings, idx);
  addPerformanceFinding(findings, root, ctx.durationNanos);
  addManagedPackageFinding(findings, idx, ctx.managedPkgRuns);
  addObservabilityFindings(findings, limitsSummary, ctx);

  return findings.sort((a, b) => {
    const severity = severityRank(b.severity) - severityRank(a.severity);
    if (severity !== 0) return severity;
    const category = categoryRank(b.category) - categoryRank(a.category);
    if (category !== 0) return category;
    return a.title.localeCompare(b.title);
  });
}

function flattenWithParents(root: CallNode): NodeIndex {
  const nodes: CallNode[] = [];
  const parent = new Map<string, CallNode | null>();
  const walk = (node: CallNode, p: CallNode | null) => {
    nodes.push(node);
    parent.set(node.id, p);
    for (const child of node.children) walk(child, node);
  };
  walk(root, null);
  return { nodes, parent };
}

function severityRank(severity: FindingSeverity): number {
  if (severity === "critical") return 3;
  if (severity === "warning") return 2;
  return 1;
}

function categoryRank(category: DiagnosisFinding["category"]): number {
  switch (category) {
    case "exception": return 100;
    case "governor-limit": return 90;
    case "repeated-soql": return 80;
    case "repeated-dml": return 70;
    case "large-query": return 60;
    case "performance": return 50;
    case "managed-package": return 20;
    case "observability": return 10;
  }
}

function addExceptionFinding(
  findings: DiagnosisFinding[],
  exceptionNode: CallNode | null,
  idx: NodeIndex,
): void {
  if (!exceptionNode) return;
  const owner = idx.parent.get(exceptionNode.id) ?? null;
  const values = owner ? recentMeaningfulAssignments(owner, 4) : [];
  const nullValue = values.find((v) => /\bnull\b/i.test(v.value));
  const isNullPointer = /nullpointer|de-reference a null object/i.test(
    `${exceptionNode.exceptionType ?? ""} ${exceptionNode.exceptionMessage ?? ""}`,
  );
  const type = exceptionNode.exceptionType ?? "Unhandled exception";
  const message = exceptionNode.exceptionMessage ?? "";
  const location = locationFor(owner ?? exceptionNode, exceptionNode.line);
  const evidence = [
    `${type}${message ? `: ${message}` : ""}`,
    ...values.map((v) => `Last value in failing frame: ${v.name} = ${truncate(v.value, 120)}`),
    ...(exceptionNode.stack?.slice(0, 3).map((s) => `Stack: ${s}`) ?? []),
  ];

  findings.push({
    id: "finding-exception",
    severity: "critical",
    category: "exception",
    title: type,
    location,
    nodeId: exceptionNode.id,
    className: owner?.className ?? exceptionNode.className,
    line: exceptionNode.line,
    summary: message || "The transaction threw an exception.",
    rootCause:
      isNullPointer && nullValue
        ? `${nullValue.name} was logged as null in the failing frame before the exception.`
        : "The log captured an unhandled exception on the active call stack.",
    evidence,
    recommendation: isNullPointer
      ? "Guard the null assumption at the failing line and verify the upstream query or assignment that should populate the value."
      : "Open the failing frame, inspect the last assignments, and fix the first user-code frame on the stack.",
    verify: "Rerun the same transaction and confirm the exception path no longer appears.",
    focusClass: owner?.className ?? null,
    trackValue: nullValue?.name ?? values[0]?.name ?? null,
  });
}

function addLimitFindings(
  findings: DiagnosisFinding[],
  limitsSummary: LimitsSummary,
  root: CallNode,
): void {
  const hotspot = hottestNode(root);
  for (const row of limitsSummary.rows) {
    if (row.max <= 0) continue;
    const pct = row.used / row.max;
    if (pct < 0.8) continue;
    const severity: FindingSeverity = pct >= 0.95 ? "critical" : "warning";
    const isCpu = /cpu/i.test(row.key);
    const isHeap = /heap/i.test(row.key);
    const focus = isCpu || isHeap ? hotspot?.className ?? null : null;
    findings.push({
      id: `finding-limit-${slug(row.key)}`,
      severity,
      category: "governor-limit",
      title: `${row.key} at ${Math.round(pct * 100)}%`,
      location: "Transaction-wide",
      nodeId: isCpu || isHeap ? hotspot?.id ?? null : null,
      className: focus,
      summary: `${row.key} used ${row.used.toLocaleString()} of ${row.max.toLocaleString()}.`,
      rootCause: isCpu || isHeap
        ? "The transaction is close to a runtime resource limit; the hottest frame is the best first place to inspect."
        : "The transaction is close to a governor limit and may fail with a slightly larger record set.",
      evidence: [
        `${row.key}: ${row.used.toLocaleString()} / ${row.max.toLocaleString()}`,
        `Execution context: ${limitsSummary.contextLabel}`,
        ...(hotspot ? [`Hottest frame: ${nodeLabel(hotspot)} (${fmtNanos(hotspot.selfNanos ?? hotspot.durationNanos)})`] : []),
      ],
      recommendation: recommendationForLimit(row.key),
      verify: "Rerun with the same scenario and confirm this limit stays below 80%.",
      focusClass: focus,
    });
  }
}

function addRepeatedSoqlFindings(findings: DiagnosisFinding[], idx: NodeIndex): void {
  const groups = new Map<string, CallNode[]>();
  for (const node of idx.nodes) {
    if (node.kind !== "soql" || !node.query) continue;
    const key = `${node.line ?? "external"}|${normalizeQuery(node.query)}`;
    const group = groups.get(key) ?? [];
    group.push(node);
    groups.set(key, group);
  }

  const repeated = [...groups.values()]
    .filter((group) => group.length >= 5)
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);

  for (const group of repeated) {
    const first = group[0];
    const parent = idx.parent.get(first.id) ?? null;
    const rows = group.reduce((sum, n) => sum + (n.rows ?? 0), 0);
    findings.push({
      id: `finding-soql-repeat-${first.id}`,
      severity: group.length >= 50 ? "critical" : "warning",
      category: "repeated-soql",
      title: `Repeated SOQL query (${group.length}x)`,
      location: locationFor(parent ?? first, first.line),
      nodeId: first.id,
      className: parent?.className ?? null,
      line: first.line,
      summary: `The same SOQL shape ran ${group.length} times in this transaction.`,
      rootCause: "This matches a common SOQL-in-loop or repeated selector-access pattern.",
      evidence: [
        `Executions: ${group.length}`,
        `Rows returned total: ${rows.toLocaleString()}`,
        `Query: ${truncate(first.query ?? "", 160)}`,
        ...(parent ? [`Caller: ${nodeLabel(parent)}`] : []),
      ],
      recommendation: "Query once outside the repeated path, then reuse results with a map or grouped collection.",
      verify: "Rerun and confirm this query executes once or only for distinct, intentional batches.",
      focusClass: parent?.className ?? null,
    });
  }
}

function addRepeatedDmlFindings(findings: DiagnosisFinding[], idx: NodeIndex): void {
  const groups = new Map<string, CallNode[]>();
  for (const node of idx.nodes) {
    if (node.kind !== "dml") continue;
    const key = `${node.line ?? "external"}|${node.dmlOp ?? "DML"}|${node.className ?? ""}`;
    const group = groups.get(key) ?? [];
    group.push(node);
    groups.set(key, group);
  }

  const repeated = [...groups.values()]
    .filter((group) => group.length >= 5)
    .sort((a, b) => b.length - a.length)
    .slice(0, 3);

  for (const group of repeated) {
    const first = group[0];
    const parent = idx.parent.get(first.id) ?? null;
    const rows = group.reduce((sum, n) => sum + (n.rows ?? 0), 0);
    findings.push({
      id: `finding-dml-repeat-${first.id}`,
      severity: group.length >= 75 ? "critical" : "warning",
      category: "repeated-dml",
      title: `Repeated DML operation (${group.length}x)`,
      location: locationFor(parent ?? first, first.line),
      nodeId: first.id,
      className: parent?.className ?? null,
      line: first.line,
      summary: `${first.dmlOp ?? "DML"} on ${first.className ?? "records"} ran ${group.length} times.`,
      rootCause: "This matches a common DML-in-loop pattern.",
      evidence: [
        `Executions: ${group.length}`,
        `Rows affected total: ${rows.toLocaleString()}`,
        ...(parent ? [`Caller: ${nodeLabel(parent)}`] : []),
      ],
      recommendation: "Collect records in memory and perform one bulk DML operation after the repeated path completes.",
      verify: "Rerun and confirm DML statements drop while affected row counts remain correct.",
      focusClass: parent?.className ?? null,
    });
  }
}

function addLargeQueryFindings(findings: DiagnosisFinding[], idx: NodeIndex): void {
  const largeQueries = idx.nodes
    .filter((node) => node.kind === "soql" && (node.rows ?? 0) >= 10000)
    .sort((a, b) => (b.rows ?? 0) - (a.rows ?? 0))
    .slice(0, 3);

  for (const query of largeQueries) {
    const parent = idx.parent.get(query.id) ?? null;
    const rows = query.rows ?? 0;
    findings.push({
      id: `finding-large-query-${query.id}`,
      severity: rows >= 50000 ? "critical" : "warning",
      category: "large-query",
      title: `Large SOQL result set (${rows.toLocaleString()} rows)`,
      location: locationFor(parent ?? query, query.line),
      nodeId: query.id,
      className: parent?.className ?? null,
      line: query.line,
      summary: `A SOQL query returned ${rows.toLocaleString()} rows.`,
      rootCause: "Large result sets can drive heap pressure, CPU pressure, and non-selective-query failures.",
      evidence: [
        `Rows returned: ${rows.toLocaleString()}`,
        `Query: ${truncate(query.query ?? "", 160)}`,
        ...(parent ? [`Caller: ${nodeLabel(parent)}`] : []),
      ],
      recommendation: "Reduce the result set with selective filters, indexed fields, or smaller processing scopes.",
      verify: "Use a query plan or rerun the log and confirm returned rows are intentionally bounded.",
      focusClass: parent?.className ?? null,
    });
  }
}

function addPerformanceFinding(
  findings: DiagnosisFinding[],
  root: CallNode,
  durationNanos: number | null,
): void {
  if (durationNanos === null || durationNanos < 5_000_000_000) return;
  const hotspot = hottestNode(root);
  if (!hotspot) return;
  const share = ((hotspot.selfNanos ?? 0) / durationNanos) * 100;
  findings.push({
    id: "finding-slow-hotspot",
    severity: durationNanos >= 10_000_000_000 ? "critical" : "warning",
    category: "performance",
    title: `Slow transaction (${fmtNanos(durationNanos)})`,
    location: "Transaction-wide",
    nodeId: hotspot.id,
    className: hotspot.className,
    summary: `The transaction took ${fmtNanos(durationNanos)}.`,
    rootCause: `${nodeLabel(hotspot)} has the highest self-time in the trace.`,
    evidence: [
      `Hottest frame: ${nodeLabel(hotspot)}`,
      `Self-time: ${fmtNanos(hotspot.selfNanos)} (${share.toFixed(0)}% of transaction)`,
    ],
    recommendation: "Inspect the hottest frame first, then reduce repeated work, cache expensive lookups, or move valid heavy work async.",
    verify: "Rerun the same transaction and compare total duration plus hottest-frame self-time.",
    focusClass: hotspot.className,
  });
}

function addManagedPackageFinding(
  findings: DiagnosisFinding[],
  idx: NodeIndex,
  managedPkgRuns: number,
): void {
  if (managedPkgRuns === 0) return;
  const packages = new Map<string, { count: number; suppressed: number; first: CallNode }>();
  for (const node of idx.nodes) {
    if (node.kind !== "managed-pkg" || !node.namespace) continue;
    const existing = packages.get(node.namespace);
    if (existing) {
      existing.count += 1;
      existing.suppressed += node.suppressedCount ?? 0;
    } else {
      packages.set(node.namespace, {
        count: 1,
        suppressed: node.suppressedCount ?? 0,
        first: node,
      });
    }
  }
  const busiest = [...packages.entries()].sort((a, b) => b[1].suppressed - a[1].suppressed)[0];
  if (!busiest) return;
  const [namespace, stats] = busiest;
  findings.push({
    id: `finding-managed-${slug(namespace)}`,
    severity: stats.suppressed >= 1000 ? "warning" : "info",
    category: "managed-package",
    title: `Managed package visibility gap: ${namespace}`,
    location: namespace,
    nodeId: stats.first.id,
    summary: `The trace entered ${namespace} ${stats.count.toLocaleString()} time${stats.count === 1 ? "" : "s"}.`,
    rootCause: "Salesforce does not emit internal METHOD_ENTRY events for managed-package code, so only boundary evidence is available.",
    evidence: [
      `Managed package runs: ${stats.count.toLocaleString()}`,
      `Hidden statements: ${stats.suppressed.toLocaleString()}`,
      `Boundary inputs: ${(stats.first.inputs?.length ?? 0).toLocaleString()}`,
      `Boundary outputs: ${(stats.first.outputs?.length ?? 0).toLocaleString()}`,
    ],
    recommendation: "Inspect boundary values and caller frames; hide the package when it is noise or focus the caller when it changes outputs.",
    verify: "Reproduce with caller-side debug statements around the package boundary if more in/out evidence is needed.",
  });
}

function addObservabilityFindings(
  findings: DiagnosisFinding[],
  limitsSummary: LimitsSummary,
  ctx: DiagnosisContext,
): void {
  if (ctx.warnings.length > 0) {
    findings.push({
      id: "finding-truncated-log",
      severity: "warning",
      category: "observability",
      title: "Log may be truncated",
      location: "Log capture",
      nodeId: null,
      summary: ctx.warnings[0],
      rootCause: "The parser reached the end of the log while one or more frames were still open.",
      evidence: ctx.warnings.slice(0, 3),
      recommendation: "Reduce noisy debug levels or capture a narrower transaction window.",
      verify: "Rerun and confirm the log closes all call frames without parser warnings.",
    });
  }

  if (!ctx.limitsAreLogged || limitsSummary.source === "estimated") {
    findings.push({
      id: "finding-log-settings",
      severity: "info",
      category: "observability",
      title: "Better log settings recommended",
      location: "Log capture",
      nodeId: null,
      summary: "Governor limits are estimated because the log does not include full cumulative limit usage.",
      rootCause: "Profiling detail is missing or incomplete in this log capture.",
      evidence: [
        `Limit source: ${limitsSummary.source}`,
        "Suggested: Apex Code = FINEST",
        "Suggested: Database = FINEST",
        "Suggested: Profiling = FINEST",
      ],
      recommendation: "Rerun with Apex Code, Database, and Profiling at FINEST for a complete diagnosis.",
      verify: "Confirm the next log contains CUMULATIVE_LIMIT_USAGE rows.",
    });
  }
}

function hottestNode(root: CallNode): CallNode | null {
  let best: CallNode | null = null;
  const walk = (node: CallNode) => {
    if (
      node.kind !== "root" &&
      node.kind !== "soql" &&
      node.kind !== "dml" &&
      (node.selfNanos ?? 0) > (best?.selfNanos ?? 0)
    ) {
      best = node;
    }
    for (const child of node.children) walk(child);
  };
  walk(root);
  return best;
}

function recentMeaningfulAssignments(node: CallNode, limit: number): ValueAssignment[] {
  return node.assignments
    .filter((assignment) => {
      const value = assignment.value.trim();
      return assignment.name !== "this" && value !== "{}" && value !== "[]";
    })
    .slice(-limit);
}

function nodeLabel(node: CallNode): string {
  if (node.kind === "root") return node.method ?? "Execution";
  if (node.kind === "managed-pkg") return `${node.namespace ?? "managed package"} (managed)`;
  if (node.kind === "soql") return "SOQL";
  if (node.kind === "dml") return node.method ?? "DML";
  if (node.kind === "exception") return node.exceptionType ?? "Exception";
  if (node.className && node.method) return `${node.className}.${node.method}`;
  return node.method ?? node.className ?? node.signature ?? "Frame";
}

function locationFor(node: CallNode, line: number | null | undefined): string {
  const label = nodeLabel(node);
  return line != null ? `${label} · line ${line}` : label;
}

function normalizeQuery(query: string): string {
  return query
    .replace(/'[^']*'/g, "'?'")
    .replace(/\b[a-zA-Z0-9]{15,18}\b/g, "?")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
}

function fmtNanos(nanos: number | null | undefined): string {
  if (nanos == null) return "—";
  const ms = nanos / 1e6;
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

function recommendationForLimit(key: string): string {
  if (/soql/i.test(key)) return "Bulkify repeated queries and move shared lookups outside loops.";
  if (/dml/i.test(key)) return "Batch record changes and perform fewer bulk DML statements.";
  if (/cpu/i.test(key)) return "Reduce repeated work, cache expensive calculations, and inspect the hottest frames first.";
  if (/heap/i.test(key)) return "Reduce in-memory collection sizes, stream large queries, and clear temporary state.";
  return "Reduce the repeated work that consumes this limit and rerun the transaction.";
}

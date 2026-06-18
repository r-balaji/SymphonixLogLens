// Shared types between the parser (server) and the UI (client).

/** A value assignment captured during execution: `name = value` at a source line. */
export interface ValueAssignment {
  line: number | null; // null when the log line is [EXTERNAL]
  name: string;
  value: string; // raw value text from the log (may be JSON, scalar, "null", etc.)
}

/** A USER_DEBUG / System.debug statement. */
export interface DebugEntry {
  line: number | null;
  level: string; // DEBUG, INFO, ERROR, ...
  message: string;
}

export type NodeKind =
  | "root"
  | "method"
  | "constructor"
  | "managed-pkg"
  | "soql"
  | "dml"
  | "exception";

/**
 * One node in the execution call tree.
 *
 * - method / constructor: home-namespace code with full detail.
 * - managed-pkg: a collapsed black box for a run of ENTERING_MANAGED_PKG markers
 *   in a foreign namespace. Its `inputs`/`outputs` are the VARIABLE_ASSIGNMENT
 *   values that bracket the run in the home code (the only honest boundary data,
 *   since SF logs no METHOD_ENTRY for foreign internals).
 */
export interface CallNode {
  id: string;
  kind: NodeKind;

  // Identity
  namespace: string | null; // e.g. "loan", "clcommon", "mfiflexUtil"
  className: string | null; // e.g. "LoanTransactionUtil"
  method: string | null; // e.g. "post" or "<init>"
  signature: string | null; // full "ns.Class.method(args)" or "<init>(args)"
  classId: string | null; // Salesforce 01p... entity id, when present
  line: number | null; // source line of the entry

  // Timing (nanoseconds from the log clock)
  startNanos: number | null;
  endNanos: number | null;
  selfNanos: number | null; // time not spent in children
  durationNanos: number | null;

  // Detail attached to this node
  assignments: ValueAssignment[];
  debugs: DebugEntry[];

  // For managed-pkg black boxes:
  suppressedCount?: number; // number of ENTERING_MANAGED_PKG markers folded
  inputs?: ValueAssignment[]; // assignments immediately before the run
  outputs?: ValueAssignment[]; // assignments immediately after the run

  // For soql / dml nodes (present only when DB logging is enabled):
  query?: string; // SOQL text
  rows?: number | null; // rows returned/affected
  dmlOp?: string; // INSERT / UPDATE / DELETE / ...

  // For exception nodes:
  exceptionType?: string; // System.NullPointerException, ...
  exceptionMessage?: string;
  stack?: string[]; // stack frames, innermost first

  // Source linking (filled in by repo resolver, optional)
  sourceFile?: string | null; // repo-relative path to the .cls
  sourceUrl?: string | null; // local/GitHub URL to jump to

  // A few raw log lines captured at this frame's boundary (for the Raw tab).
  rawLines?: string[];

  // True if this node is on the path from root to a thrown exception.
  onPath?: boolean;

  children: CallNode[];
}

/** Governor-limit usage, when CUMULATIVE_LIMIT_USAGE is present in the log. */
export interface LimitUsage {
  key: string; // "SOQL queries", "CPU time (ms)", ...
  used: number;
  max: number;
}

export interface ParseStats {
  totalLines: number;
  events: Record<string, number>;
  homeNamespace: string;
  foreignNamespaces: string[];
  methodCalls: number;
  managedPkgRuns: number;
  soqlCount: number;
  dmlCount: number;
  durationNanos: number | null;
  baselineNanos: number | null; // earliest start; flame x = (start - baseline)/duration
  // Which optional event families this log actually contains. The UI hides
  // panels for families that are absent (e.g. DB logging was off).
  hasSoql: boolean;
  hasDml: boolean;
  hasLimits: boolean;
  hasException: boolean;
}

export interface ParseResult {
  apiVersion: string;
  logLevels: string; // raw first-line levels string
  user: string | null; // from USER_INFO if present
  codeUnit: string | null; // the entry CODE_UNIT label (e.g. "VF: /apex/...")
  root: CallNode;
  stats: ParseStats;
  limits: LimitUsage[];
  exception: CallNode | null; // the thrown exception node, if any
  warnings: string[];
}

export interface ParseOptions {
  /** The home namespace; anything else namespaced is folded into a black box. */
  homeNamespace: string;
}

import type { CallNode, ValueAssignment } from "../../shared/types.js";

/** Build a parent/index map for O(1) lookups and path-building. */
export interface TreeIndex {
  byId: Map<string, CallNode>;
  parent: Map<string, string | null>;
}

export function indexTree(root: CallNode): TreeIndex {
  const byId = new Map<string, CallNode>();
  const parent = new Map<string, string | null>();
  const walk = (n: CallNode, p: string | null) => {
    byId.set(n.id, n);
    parent.set(n.id, p);
    for (const c of n.children) walk(c, n.id);
  };
  walk(root, null);
  return { byId, parent };
}

/** Path of nodes from root down to (and including) the given id. */
export function pathTo(idx: TreeIndex, id: string): CallNode[] {
  const path: CallNode[] = [];
  let cur: string | null = id;
  while (cur) {
    const node = idx.byId.get(cur);
    if (!node) break;
    path.unshift(node);
    cur = idx.parent.get(cur) ?? null;
  }
  return path;
}

/** A short, human label for a node (used in breadcrumbs and cards). */
export function label(n: CallNode): string {
  if (n.kind === "root") return n.method ?? "Execution";
  if (n.kind === "managed-pkg") return `${n.namespace} (pkg)`;
  if (n.kind === "soql") return "SOQL";
  if (n.kind === "dml") return n.method ?? "DML";
  if (n.kind === "exception") return n.exceptionType ?? "Exception";
  const cls = n.className ?? "";
  const m = n.method && n.method !== "<init>" ? n.method : "new";
  return cls ? `${cls}.${m}` : (n.method ?? n.signature ?? "?");
}

/** The TraceLens chip letter for a node kind. */
export function chipFor(n: CallNode): "M" | "C" | "Q" | "D" | "F" | "E" | "X" {
  switch (n.kind) {
    case "constructor": return "C";
    case "soql": return "Q";
    case "dml": return "D";
    case "managed-pkg": return "E";
    case "exception": return "X";
    case "root": return "F";
    default: return "M";
  }
}

/** Assignments worth showing (drop `this` self-refs and empty snapshots). */
export function meaningfulValues(n: CallNode): ValueAssignment[] {
  return n.assignments.filter((a) => {
    const v = a.value.trim();
    if (a.name === "this") return false;
    if (v === "{}" || v === "[]") return false;
    return true;
  });
}

/**
 * The distinct home/foreign class names invoked anywhere inside a subtree
 * (excluding the node itself), most-frequent first. Lets a card show
 * "touches: LoanAccountDomainObject, EMI, …" so the developer can see what
 * work is buried deeper before peeling in.
 */
export function subtreeTouches(n: CallNode, max = 5): { names: string[]; total: number } {
  const counts = new Map<string, number>();
  const ownClass = n.className;
  const walk = (node: CallNode, isRoot: boolean) => {
    if (!isRoot && node.className && node.className !== ownClass) {
      counts.set(node.className, (counts.get(node.className) ?? 0) + 1);
    }
    if (!isRoot && node.kind === "managed-pkg" && node.namespace) {
      const key = `${node.namespace} (pkg)`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const c of node.children) walk(c, false);
  };
  walk(n, true);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return { names: sorted.slice(0, max).map(([name]) => name), total: counts.size };
}

/** One waterfall lane: a class, spanning its first→last call, sized by total time. */
export interface WaterfallRow {
  className: string;
  namespace: string | null;
  isManaged: boolean;
  hasError: boolean;
  startNanos: number; // earliest start of any frame of this class
  endNanos: number; // latest end
  selfNanos: number; // summed self-time across all its frames (time actually in this class)
  calls: number;
  firstNodeId: string; // a representative frame to select on click
}

/**
 * Aggregate the trace into per-class lanes for the waterfall. Each class gets one
 * row spanning from its first invocation to its last, with summed self-time so
 * the bar reflects time actually spent in that class (not double-counting
 * children). Sorted by self-time so the heaviest classes lead.
 */
export function waterfallByClass(root: CallNode): WaterfallRow[] {
  const map = new Map<string, WaterfallRow>();
  const walk = (n: CallNode) => {
    if (n.className && n.startNanos !== null && n.endNanos !== null) {
      const key = `${n.namespace ?? ""}|${n.className}`;
      const existing = map.get(key);
      const self = n.selfNanos ?? 0;
      const err = n.debugs.some((d) => /error|fatal/i.test(d.level)) || n.kind === "exception";
      if (existing) {
        existing.startNanos = Math.min(existing.startNanos, n.startNanos);
        existing.endNanos = Math.max(existing.endNanos, n.endNanos);
        existing.selfNanos += self;
        existing.calls += 1;
        existing.hasError = existing.hasError || err;
      } else {
        map.set(key, {
          className: n.className,
          namespace: n.namespace,
          isManaged: n.kind === "managed-pkg",
          hasError: err,
          startNanos: n.startNanos,
          endNanos: n.endNanos,
          selfNanos: self,
          calls: 1,
          firstNodeId: n.id,
        });
      }
    }
    // managed-pkg nodes carry a namespace but no className — lane them by namespace.
    if (n.kind === "managed-pkg" && n.namespace && n.startNanos !== null && n.endNanos !== null) {
      const key = `pkg|${n.namespace}`;
      const existing = map.get(key);
      const dur = n.durationNanos ?? 0;
      if (existing) {
        existing.startNanos = Math.min(existing.startNanos, n.startNanos);
        existing.endNanos = Math.max(existing.endNanos, n.endNanos);
        existing.selfNanos += dur;
        existing.calls += 1;
      } else {
        map.set(key, {
          className: n.namespace,
          namespace: n.namespace,
          isManaged: true,
          hasError: false,
          startNanos: n.startNanos,
          endNanos: n.endNanos,
          selfNanos: dur,
          calls: 1,
          firstNodeId: n.id,
        });
      }
    }
    for (const c of n.children) walk(c);
  };
  walk(root);
  return [...map.values()].sort((a, b) => b.selfNanos - a.selfNanos);
}

/**
 * A noise filter. `value` matches against a node's namespace, class, method, or
 * "Class.method". A trailing/leading `*` is treated as a wildcard; otherwise it
 * is a case-insensitive substring match so "clcommon" hides the whole package
 * and "PlatformLog" hides that class.
 */
export interface Filter {
  id: string;
  value: string;
}

function matchesFilter(n: CallNode, f: Filter): boolean {
  const needle = f.value.trim().toLowerCase();
  if (!needle) return false;
  const candidates = [
    n.namespace ?? "",
    n.className ?? "",
    n.method ?? "",
    n.className && n.method ? `${n.className}.${n.method}` : "",
    n.namespace && n.className ? `${n.namespace}.${n.className}` : "",
  ].map((s) => s.toLowerCase());

  const star = needle.includes("*");
  if (star) {
    const re = new RegExp("^" + needle.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$");
    return candidates.some((c) => c && re.test(c));
  }
  return candidates.some((c) => c.includes(needle));
}

function isHidden(n: CallNode, filters: Filter[]): boolean {
  return n.kind !== "root" && filters.some((f) => matchesFilter(n, f));
}

/** One stop in a variable's life: where it was set and to what. */
export interface TimelineEntry {
  node: CallNode; // the method/constructor that made the assignment
  ownerLabel: string; // "Class.method"
  name: string; // the assigned name (may be "this.field")
  line: number | null;
  value: string;
  changed: boolean; // value differs from the previous entry for this name
}

/**
 * Every assignment whose name matches `query` (substring, case-insensitive),
 * in execution order, with the owning method and a `changed` flag so you can
 * watch a number mutate down the call chain. Pre-order DFS == execution order,
 * because the tree was built in log order.
 */
export function valueTimeline(root: CallNode, query: string): TimelineEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const entries: TimelineEntry[] = [];
  const lastByName = new Map<string, string>();

  const walk = (n: CallNode) => {
    for (const a of n.assignments) {
      if (a.name === "this") continue;
      if (!a.name.toLowerCase().includes(q)) continue;
      const prev = lastByName.get(a.name);
      entries.push({
        node: n,
        ownerLabel: label(n),
        name: a.name,
        line: a.line,
        value: a.value,
        changed: prev !== undefined && prev !== a.value,
      });
      lastByName.set(a.name, a.value);
    }
    for (const c of n.children) walk(c);
  };
  walk(root);
  return entries;
}

/**
 * Rebuild the tree with hidden nodes spliced out: a hidden node disappears and
 * its (recursively filtered) children attach to the hidden node's parent, so the
 * call chain stays intact minus the noise. Returns a new tree; originals are not
 * mutated.
 */
export function filterTree(root: CallNode, filters: Filter[]): CallNode {
  if (filters.length === 0) return root;

  const filterChildren = (children: CallNode[]): CallNode[] => {
    const out: CallNode[] = [];
    for (const c of children) {
      const keptChildren = filterChildren(c.children);
      if (isHidden(c, filters)) {
        // Splice: lift this node's surviving children up to the parent.
        out.push(...keptChildren);
      } else {
        out.push({ ...c, children: keptChildren });
      }
    }
    return out;
  };

  return { ...root, children: filterChildren(root.children) };
}

/**
 * Prune the tree to a "focus area": keep only frames whose class is in
 * `classes`, together with their full subtrees. A focused frame found deep in
 * the tree is lifted so the user sees just that class's behavior wherever it
 * runs, without the unrelated branches in between. Returns a new tree.
 */
export function focusTree(root: CallNode, classes: string[]): CallNode {
  if (classes.length === 0) return root;
  const want = new Set(classes.map((c) => c.toLowerCase()));
  const isFocused = (n: CallNode) =>
    n.className != null && want.has(n.className.toLowerCase());

  // Collect, in execution order, the topmost focused frames (don't double-count
  // a focused class nested inside another focused frame — the outer keeps it).
  const tops: CallNode[] = [];
  const walk = (n: CallNode) => {
    if (isFocused(n)) {
      tops.push(n);
      return; // its subtree comes along whole
    }
    for (const c of n.children) walk(c);
  };
  for (const c of root.children) walk(c);

  return { ...root, children: tops };
}

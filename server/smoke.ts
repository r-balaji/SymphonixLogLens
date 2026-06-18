import { readFileSync } from "node:fs";
import { parseLog } from "../shared/parser.js";
import type { CallNode } from "../shared/types.js";

const file = process.argv[2] ?? "log-payment.txt";
const home = process.argv[3] ?? "loan";
const text = readFileSync(file, "utf8");

const t0 = Date.now();
const r = parseLog(text, { homeNamespace: home });
const ms = Date.now() - t0;

function count(n: CallNode): { nodes: number; mp: number; depth: number } {
  let nodes = 1;
  let mp = n.kind === "managed-pkg" ? 1 : 0;
  let depth = 0;
  for (const c of n.children) {
    const r = count(c);
    nodes += r.nodes;
    mp += r.mp;
    depth = Math.max(depth, r.depth + 1);
  }
  return { nodes, mp, depth };
}
const c = count(r.root);

console.log("file        :", file);
console.log("parse ms    :", ms);
console.log("api / levels:", r.apiVersion);
console.log("user        :", r.user);
console.log("home / foreign:", r.stats.homeNamespace, "/", r.stats.foreignNamespaces.join(", "));
console.log("methodCalls :", r.stats.methodCalls);
console.log("mp runs     :", r.stats.managedPkgRuns);
console.log("tree nodes  :", c.nodes, "| mp nodes:", c.mp, "| max depth:", c.depth);
console.log("warnings    :", r.warnings);

// Print a shallow slice of the tree to eyeball structure.
function show(n: CallNode, d: number, max = 30, budget = { n: 0 }): void {
  if (budget.n > max) return;
  const pad = "  ".repeat(d);
  const label =
    n.kind === "managed-pkg"
      ? `[MP ${n.namespace} x${n.suppressedCount} in:${n.inputs?.length ?? 0} out:${n.outputs?.length ?? 0}]`
      : `${n.signature ?? n.method ?? "?"}${n.assignments.length ? ` (${n.assignments.length} vals)` : ""}`;
  console.log(pad + label);
  budget.n++;
  for (const ch of n.children) show(ch, d + 1, max, budget);
}
console.log("\n--- tree (first ~30 nodes) ---");
show(r.root, 0);

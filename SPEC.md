# LogPlayBook — v1 Spec

A local web app for the Q2 dev + support teams. It takes a Salesforce **FINEST**
debug log (from a namespaced org), parses the execution, and renders a
**beautiful, interactive call-tree flowchart**: method → method calls with class
references and inline value assignments. Calls into *foreign* managed-package
namespaces are collapsed into "black box" nodes that show whatever the log
exposes at the boundary.

> Status: requirements locked. Parser to be built against a real sample log
> (drop a `.log` into the project root) before any parsing code is written.

---

## Locked decisions

| Area            | Decision |
|-----------------|----------|
| Ingestion       | Upload a `.log` file (drag/drop). Standalone parse, no live org. |
| Source linking  | Point at a **locally cloned repo** (path + commit/tag); read `.cls` to enrich nodes & enable jump-to-source. |
| Form factor     | **Local web app** — React frontend + small local Node server for parsing & repo reads. |
| MP detection    | **By namespace prefix.** A configurable *home* namespace in the UI; anything else namespaced = black box. |
| Hero diagram    | **Collapsible call-tree / flowchart**, value-assignment chips on nodes. |
| Log size        | Handle up to Salesforce's ~20MB single-log cap; streaming parse + lazy/collapsed rendering. |
| Black box       | Default **collapsed** node: `Managed package: <ns> (N statements)`. Click to reveal the `VARIABLE_ASSIGNMENT` values bracketing the run (inputs before / outputs after) — the only honest in/out data, since foreign internals are not logged. |
| Home namespace  | **Configurable in the UI** (per session). |
| Demo priority   | **Wow factor** — polished interactive flowchart. |

---

## v1 scope (the demo)

1. Drop a `.log` → it parses Salesforce log events
   (`CODE_UNIT_STARTED/FINISHED`, `METHOD_ENTRY/EXIT`, `VARIABLE_ASSIGNMENT`,
   `SYSTEM_METHOD_ENTRY/EXIT`, DML/SOQL events).
2. Renders a collapsible call-tree: each node = `Class.method`, expandable, with
   value-assignment chips inline.
3. Foreign-namespace calls render as distinct **black-box nodes**
   (enter → params, exit → returns, "N statements hidden").
4. Set **home namespace** in the UI; the tree re-collapses live.
5. Point at a local repo + commit → nodes that resolve to a `.cls` get a
   **jump-to-source** affordance (and method-signature enrichment).
6. Search/filter, collapse-all/expand-all, basic per-node timing.

## Explicitly OUT of v1 (v2+)

- Live org / Tooling API log pull
- GitHub API fetch by SHA (v1 uses a local clone)
- Sequence + class-relationship-graph diagram views (call-tree only for now)
- Multi-log stitching / very large multi-transaction handling

---

## Proposed stack

- **Frontend:** React + Vite + TypeScript. Custom collapsible tree render for
  full control over value chips and black-box nodes (lighter and prettier than
  forcing a generic graph lib).
- **Backend:** Node/Express (or Vite middleware). Handles the heavy streaming
  log parse and local repo file reads off the browser thread; keeps the UI
  smooth on 20MB logs.

---

## Confirmed log grammar (from real sample `log-eg.txt`, 179k lines, 512KB)

Header line 1: `63.0 APEX_CODE,FINEST;APEX_PROFILING,NONE;...` (version + log levels).
All other lines: `HH:MM:SS.mmm (nanos)|EVENT_TYPE|...payload`. Values never wrap
to a second line (JSON snapshots are single-line).

| Event | Format | Role in tree |
|-------|--------|--------------|
| `CODE_UNIT_STARTED` | `\|[EXTERNAL]\|id\|VF: /apex/loan__rescheduleALoan` | root node |
| `CODE_UNIT_FINISHED` | `\|VF: /apex/...` | close root |
| `METHOD_ENTRY` | `\|[line]\|classId\|ns.Class.method(sig)` | **push** call node |
| `METHOD_EXIT` | `\|[line]\|ns.Class` | **pop** call node |
| `CONSTRUCTOR_ENTRY` | `\|[line]\|classId\|<init>(sig)\|ns.Class` | **push** (treat as call) |
| `CONSTRUCTOR_EXIT` | `\|[line]\|classId\|<init>(sig)\|ns.Class` | **pop** |
| `VARIABLE_ASSIGNMENT` | `\|[line]\|name\|value\|heapRef?` | **value chip** on current node |
| `ENTERING_MANAGED_PKG` | `\|ns` (e.g. `clcommon`, `mfiflexUtil`) | **black-box** marker |
| `USER_DEBUG` | `\|[line]\|LEVEL\|message` | annotation on current node |
| `STATEMENT_EXECUTE`, `HEAP_ALLOCATE`, `VARIABLE_SCOPE_BEGIN` | — | noise: skip in tree, keep counts only |

### Critical insight that shapes the black box
`ENTERING_MANAGED_PKG|<ns>` is the real Salesforce signal for crossing into a
*foreign* managed package. In this log it fires **18,726 times** for `clcommon`
(18,317) and `mfiflexUtil` (409). **Salesforce emits NO `METHOD_ENTRY` for the
internal calls of those packages** — they are genuinely invisible. So a foreign
call is a *run* of consecutive `ENTERING_MANAGED_PKG|ns` markers with no method
detail and no boundary params in the event itself.

The black-box node therefore shows: **namespace + count of suppressed
statements**, plus the **`VARIABLE_ASSIGNMENT` values that immediately precede
(inputs) and follow (outputs) the run** in the home code — that is the only
honest "in→/out→" data available. This matches the agreed "whatever the log
exposes, gracefully" decision.

### Home vs. foreign in this sample
- **Home namespace = `loan`** (the package being debugged; full method trees,
  rich `VARIABLE_ASSIGNMENT` JSON snapshots, e.g. `numberOfInstallments=176`).
- **Foreign (collapse) = `clcommon`, `mfiflexUtil`** (only `ENTERING_MANAGED_PKG`).
- Home namespace stays **configurable in the UI** — the parser flags any
  namespaced symbol whose prefix != home as foreign, and folds
  `ENTERING_MANAGED_PKG` runs into black-box nodes.

### Notes
- `[EXTERNAL]` appears as the line-number field for system/VF-context lines; treat
  as "no home source line."
- No standalone exception/`FATAL_ERROR` events in this sample; `ERROR` only ever
  appears as the *level* field of `USER_DEBUG`. Parser must still tolerate
  `EXCEPTION_THROWN` / `FATAL_ERROR` if a future log has them.

## Open / deferred questions

- Exact black-box boundary extraction depends on what the real namespaced FINEST
  log exposes — to be confirmed against the sample log.
- Repo commit/tag resolution UX (path picker vs. typed path) — decide during build.

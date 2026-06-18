# Symphonix Log Lens — Code Flow & Architecture (Technical)

*For developers maintaining or extending the tool.*

---

## 1. Stack & layout

- **Frontend:** React 18 + TypeScript, bundled by **Vite**. Entry `src/main.tsx`.
- **Backend:** **Express** (Node, run with `tsx`). Entry `server/index.ts`.
- **Shared core:** `shared/` — framework-free TypeScript used by both sides
  (the parser and the type contract).
- **Dev:** `npm run dev` runs both concurrently — Vite on `:5173`, Express on
  `:8787`. Vite proxies `/api/*` → `:8787` (see `vite.config.ts`).

```
shared/         types.ts          ← the data contract (CallNode, ParseResult, …)
                parser.ts         ← the log → tree parser (the heart)
server/         index.ts          ← Express: /api/parse, /api/repo, /api/source
                repo.ts           ← RepoIndex: scan a local SFDX repo, resolve classes→files
src/            main.tsx          ← React bootstrap, imports tracelens.css
                App.tsx           ← top-level state + layout (the orchestrator)
                tracelens.css     ← all styling + light/dark theme tokens
   lib/         api.ts            ← fetch wrappers for the 3 endpoints
                tree.ts           ← pure tree algorithms (index, filter, focus, waterfall, timeline…)
                format.ts         ← value classification + duration formatting
   components/  TraceTree.tsx     ← left pane: recursive call tree
                Inspector.tsx     ← right pane: crumbs + Values/Source/Raw tabs
                Waterfall.tsx     ← per-class timing lanes
```

---

## 2. End-to-end data flow

```
.log file
   │  (drag/drop or browse)
   ▼
App.handleFile()  ──POST multipart──►  server /api/parse
   │                                        │
   │                                   parseLog(text, {homeNamespace})   [shared/parser.ts]
   │                                        │  + RepoIndex.enrich (source links) if a repo is connected
   │                                        ▼
   ◄────────────── JSON ParseResult ────────
   │
   ▼
new Session pushed → setActiveId → primeView()
   │
   ▼
result derived → viewRoot = focusTree(filterTree(root, filters), focusClasses)
   │
   ├─► Waterfall   (waterfallByClass(viewRoot))
   ├─► TraceTree   (recursive render of viewRoot)
   └─► Inspector / TimelinePane (selected node detail)
```

The browser never parses the 20 MB file — the **server** does (off the UI
thread), and returns a compact tree as JSON.

---

## 3. The parser — `shared/parser.ts`

This is the core. `parseLog(text, { homeNamespace })` does **one streaming pass**
over the log lines and returns a `ParseResult`.

### 3.1 Line grammar
Every event line matches:
```
LINE_RE = /^(\d{2}:\d{2}:\d{2}\.\d+)\s+\((\d+)\)\|([A-Z_]+)\|(.*)$/s
                 timestamp          nanos        EVENT_TYPE  payload
```
The first physical line is the header (`63.0 APEX_CODE,FINEST;...`) → API version
+ log levels.

### 3.2 The call stack
The parser keeps a `stack: CallNode[]` (root at the bottom). It walks events:

| Event | Action |
|-------|--------|
| `CODE_UNIT_STARTED` | push a unit node (the entry point, e.g. a VF page) |
| `METHOD_ENTRY` / `CONSTRUCTOR_ENTRY` | parse `ns.Class.method(args)`, push a node onto `top().children` and the stack |
| `METHOD_EXIT` / `CONSTRUCTOR_EXIT` / `CODE_UNIT_FINISHED` | set `endNanos`, pop |
| `VARIABLE_ASSIGNMENT` | append `{name, value, line}` to the current node’s `assignments` |
| `USER_DEBUG` | append to the current node’s `debugs` |
| `ENTERING_MANAGED_PKG <ns>` | **fold** into a managed-pkg node (see 3.3) |
| `SOQL_EXECUTE_BEGIN/END`, `DML_BEGIN/END` | push/pop `soql`/`dml` nodes (only present if DB logging on) |
| `EXCEPTION_THROWN` / `FATAL_ERROR` | create an `exception` node, snapshot the live stack, mark the whole open stack `onPath = true` |
| `CUMULATIVE_LIMIT_USAGE` / `LIMIT_USAGE_FOR_NS` | scrape governor-limit numbers from recent raw lines |
| `STATEMENT_EXECUTE`, `HEAP_ALLOCATE`, `VARIABLE_SCOPE_BEGIN` | counted only, ignored in the tree (noise) |

### 3.3 The managed-package fold (key design)
Salesforce emits **no** `METHOD_ENTRY` for foreign-package internals — only a run
of `ENTERING_MANAGED_PKG|<ns>` markers. The parser **folds** consecutive markers
of the same namespace into a single `managed-pkg` node, counting the suppressed
statements (`suppressedCount`) and capturing the `VARIABLE_ASSIGNMENT`s bracketing
the run as `inputs` / `outputs`. Any namespace ≠ `homeNamespace` is "foreign."
*(See the project memory note on this — it’s the non-obvious crux of the whole
tool.)*

### 3.4 Post-pass
- `computeTiming(root)` — bottom-up: `durationNanos = end - start`, and
  `selfNanos = duration − Σ children duration` (time actually in this frame).
- `baselineNanos` = earliest start (the zero point for timeline/waterfall x-pos).
- A handful of `rawLines` are attached per frame for the Raw tab.
- Stats + presence flags (`hasSoql`, `hasDml`, `hasLimits`, `hasException`) drive
  conditional UI.

Output shape: `ParseResult` (see `shared/types.ts`) — `root` `CallNode` tree
plus `stats`, `limits`, `exception`, `codeUnit`, `user`, `warnings`.

Performance: ~20–75 ms for an 8–20 MB log (single linear pass, no regex
backtracking on the hot path beyond `LINE_RE`).

---

## 4. The server — `server/`

### `server/index.ts`
- `POST /api/parse` — `multer` memory upload (≤30 MB) → `parseLog` →
  if a repo is connected, `enrichWithSource()` walks the tree and attaches
  `sourceFile` + `sourceUrl` to home-namespace nodes → returns JSON + `parseMs`.
- `POST /api/repo` — builds a `RepoIndex` from a local path.
- `GET /api/source?path=&method=` — returns a file’s contents + the line where the
  method is declared (for the Source tab).
- `GET /api/health` — liveness.

### `server/repo.ts` — `RepoIndex`
Recursively scans a local SFDX checkout for `*.cls`, indexing **basename →
repo-relative path** (SFDX convention: filename == class name). `resolve(className)`
gives the path; `findMethodLine(path, method)` does a best-effort regex scan for
the declaration line. One index per server process.

---

## 5. The pure tree algorithms — `src/lib/tree.ts`

All UI features are thin renderers over these pure functions:

| Function | Purpose |
|----------|---------|
| `indexTree(root)` | builds `byId` + `parent` maps for O(1) lookup & path-building |
| `pathTo(idx, id)` | root→node breadcrumb path |
| `label(n)` / `chipFor(n)` | display label + the M/C/Q/D/F/E/X chip letter |
| `meaningfulValues(n)` | assignments minus noise (`this`, empty `{}`/`[]`) |
| `filterTree(root, filters)` | **Hide**: returns a new tree with matched nodes *spliced out* (children lifted to parent) |
| `focusTree(root, classes)` | **Focus area**: returns a tree of only the topmost frames of the named classes (+ their subtrees) |
| `waterfallByClass(root)` | aggregates frames into per-class lanes (first→last span, summed self-time), sorted by self-time |
| `valueTimeline(root, name)` | every assignment to a variable name, in execution order, with a `changed` flag |
| `assignmentNames(root)` | distinct variable names ranked by frequency (timeline picker) |
| `subtreeTouches(n)` | distinct classes invoked under a node ("touches" badge) |
| `searchTree` / `hotness` / `subtreeFlags` | search, time-share, error-in-subtree |

All are **immutable** — they return new objects, never mutate the parsed tree, so
the original `result.root` stays the single source of truth.

---

## 6. The UI — `src/`

### `App.tsx` (orchestrator)
Holds all state and composes the layout. Key state:
- `sessions[]` + `activeId` → `result` (derived). Multi-log support.
- `theme` (`dark`/`light`) → sets `data-theme` on `<html>`, persisted to
  `localStorage`.
- View state: `selId`, `query`, `pathOnly`, `expandAll`, `openIds` (Set of
  expanded node ids), `trackName` (active value timeline), `showFlame` (waterfall
  collapsed by default), `filters`, `focusClasses`.

The **derived view tree**:
```ts
viewRoot = focusTree(filterTree(result.root, filters), focusClasses)
```
and `safeSelId` re-points the selection if the focused/filtered tree no longer
contains it. Every pane renders from `viewRoot`, so Hide/Focus apply everywhere at
once.

Layout (top→bottom): `Header` → optional exception banner → `Waterfall` (in the
collapsible `flamewrap`) → `HeroStrip` (metrics) → `FilterFocusBar` → `main`
(SessionRail | TraceTree | Inspector-or-TimelinePane).

### `TraceTree.tsx`
Recursive `<Row>`. Each row: twist (expand/collapse, toggles `openIds`), kind chip,
label, badges (touches / value count / rows / line / **◎ focus**), and a duration
+ heat bar. `visibleDeep` memoizes search/path-only filtering. Managed-pkg rows get
the distinct purple 🔒 treatment.

### `Inspector.tsx`
Indexes `viewRoot`, resolves the selected node, renders breadcrumbs + signature +
3 tabs:
- **Values** — table; names are click-to-track (→ `onTrack` opens the timeline);
  object/array values collapse to `{ N fields }` via `classifyValue` and expand to
  pretty JSON.
- **Source** — lazy `fetchSource(node.sourceUrl)`, highlights & scrolls to the line.
- **Raw** — the captured `rawLines`.
Exception nodes also render a red cause card with the stack.

### `Waterfall.tsx`
`waterfallByClass(viewRoot)` → lanes positioned by `(start − baseline)/total`,
sized by self-time, colored by time-share (heat) or violet (managed). Top 14 with
a "show all N classes" toggle. Clicking a lane selects a representative frame.

### `lib/format.ts`
`classifyValue(raw)` decides if a logged value is null / bool / number / string /
object / array (drives chip vs. expandable JSON). `fmtDuration(nanos)` → µs/ms/s.

### `lib/api.ts`
Thin `fetch` wrappers: `parseLogFile`, `connectRepo`, `fetchSource`.

---

## 7. Theming
`tracelens.css` defines all colors as CSS custom properties on `:root` (dark) and
overrides them under `:root[data-theme="light"]`. Notable tokens: `--bg`,
`--panel`, `--text`, the syntax accents (`--cls/--mth/--soql/--dml/--violet`),
`--code-bg/--code-text` (source & JSON panels), `--bar-bg` (header/rail/strips),
`--hover`. The toggle in `App.tsx` just flips the attribute; no component knows
about the theme.

---

## 8. Extending it — common tasks

- **Recognize a new log event:** add a `case` in the `parseLog` switch
  (`shared/parser.ts`); add fields to `CallNode`/`ParseResult` in
  `shared/types.ts` if it carries new data.
- **New tree-derived view:** add a pure function to `src/lib/tree.ts`, render it in
  a new component, wire it from `App.tsx` using `viewRoot`.
- **New inspector tab:** extend the `Tab` union + tab bar + body switch in
  `Inspector.tsx`.
- **Surfacing more from a richer log:** SOQL/DML/limit/exception parsing already
  exists but is dormant on logs without `DB`/`APEX_PROFILING` enabled — feed a
  richer log and the conditional panels activate automatically.

---

## 9. Known constraints / deliberate choices
- Method **arguments** are not in Salesforce logs — only the typed signature and
  in-method `VARIABLE_ASSIGNMENT`s. "Values at this frame" + carried context is the
  honest best available.
- Managed-package internals are genuinely invisible; the black box is the faithful
  representation, not a limitation we can engineer away.
- Single-user local tool: one `RepoIndex` per process; sessions live in browser
  memory (no persistence beyond the current tab, except the theme choice).

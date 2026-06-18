# LogPlayBook

Turn a Salesforce **FINEST** debug log into an interactive call-flow diagram.
Built for the Q2 dev + support teams working in namespaced lending orgs.

- **Call tree** of every `Class.method` / constructor in your **home namespace**,
  with execution timing and self-time.
- **Value chips** — every `VARIABLE_ASSIGNMENT` (locals, JSON record snapshots,
  scalars) shown inline on the method that set it.
- **Managed-package black boxes** — calls into *foreign* namespaces (anything
  that isn't your home namespace) are folded into a single node showing the
  namespace, hidden-statement count, and any boundary values the log exposes.
- **Jump to source** — point at a locally cloned SFDX repo and click a node to
  open the `.cls` at the method.
- **Search** across method names and values; expand/collapse all.

Everything runs locally; logs never leave your machine.

## Run

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

1. Set your **home namespace** (default `loan`).
2. *(Optional)* paste a path to your cloned SFDX repo and click **connect** to
   enable jump-to-source.
3. Drop a `.log` (or `.txt`) debug log onto the page.

## How it reads the log

The parser keys off Salesforce's own events:

| Event | Becomes |
|-------|---------|
| `METHOD_ENTRY` / `CONSTRUCTOR_ENTRY` … `_EXIT` | a node in the call tree |
| `VARIABLE_ASSIGNMENT` | a value chip on the current node |
| `ENTERING_MANAGED_PKG <ns>` | a managed-package black box (runs are folded) |
| `USER_DEBUG` | a debug line under the node |
| `STATEMENT_EXECUTE`, `HEAP_ALLOCATE`, `VARIABLE_SCOPE_BEGIN` | counted, not drawn |

Salesforce emits **no** method detail for foreign-package internals — they only
appear as `ENTERING_MANAGED_PKG` markers — so the black box is the most faithful
representation possible. See [SPEC.md](SPEC.md) for the full grammar and the v1
scope decisions.

## Architecture

- `shared/parser.ts` — single-pass streaming log parser (framework-free).
- `server/` — Express: `/api/parse` (upload + parse), `/api/repo` + `/api/source`
  (local repo indexing & source serving).
- `src/` — React + Vite UI: drop zone, stat bar, collapsible tree, source modal.

Parses a 20 MB / 180k-line log in well under 100 ms.

## Not in v1 (planned)

- Live org / Tooling API log pull (today: upload a file)
- GitHub fetch by commit SHA (today: local clone)
- Sequence-diagram and class-relationship views (today: call tree)

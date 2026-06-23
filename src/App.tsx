import { useCallback, useEffect, useMemo, useState } from "react";
import { connectRepo, disconnectRepo, parseLogFile, type ParseResponse } from "./lib/api.js";
import type { LimitsSummary } from "../shared/types.js";
import { fmtDuration } from "./lib/format.js";
import { filterTree, focusTree, indexTree, valueTimeline, type Filter } from "./lib/tree.js";
import { Waterfall } from "./components/Waterfall.js";
import { TraceTree } from "./components/TraceTree.js";
import { Inspector } from "./components/Inspector.js";

export interface Session {
  id: string;
  fileName: string;
  fileSize: number;
  file: File; // kept so we can re-parse when a repo is connected later
  homeNs: string; // the namespace this session was parsed with
  result: ParseResponse;
  status: "failed" | "slow" | "ok";
}

const SLOW_MS = 5000; // a transaction over 5s is flagged "slow"

function statusOf(r: ParseResponse): Session["status"] {
  if (r.stats.hasException) return "failed";
  if ((r.stats.durationNanos ?? 0) / 1e6 > SLOW_MS) return "slow";
  return "ok";
}

type Theme = "dark" | "light";

export function App() {
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem("loglens-theme") as Theme) || "dark",
  );

  // Width (px) of the call-tree column; the inspector takes the rest. Dragged
  // via the divider between them. Resets to default each load (not persisted).
  const [treeWidth, setTreeWidth] = useState<number | null>(null);
  const startTreeResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const main = (e.currentTarget as HTMLElement).closest("main");
    if (!main) return;
    const railW = 230; // keep in sync with .with-rail first column
    const onMove = (ev: MouseEvent) => {
      const rect = main.getBoundingClientRect();
      // tree width = pointer x, minus the rail and the main's left edge.
      const w = ev.clientX - rect.left - railW;
      const min = 320;
      const max = rect.width - railW - 360; // leave room for the inspector
      setTreeWidth(Math.max(min, Math.min(max, w)));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("loglens-theme", theme);
  }, [theme]);

  const [homeNs, setHomeNs] = useState("loan");
  const [repoUrl, setRepoUrl] = useState("");
  const [repoToken, setRepoToken] = useState("");
  const [repoBranch, setRepoBranch] = useState("main");
  const [repos, setRepos] = useState<Record<string, { url: string; branch: string; classCount: number }>>({});
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyFile, setBusyFile] = useState<string | null>(null);
  const [repoCloning, setRepoCloning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drag, setDrag] = useState(false);

  const result = useMemo(
    () => sessions.find((s) => s.id === activeId)?.result ?? null,
    [sessions, activeId],
  );

  const [selId, setSelId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [pathOnly, setPathOnly] = useState(false);
  const [expandAll, setExpandAll] = useState(false);
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [trackName, setTrackName] = useState<string | null>(null);
  const [showFlame, setShowFlame] = useState(false);
  const [showLimits, setShowLimits] = useState(true);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [focusClasses, setFocusClasses] = useState<string[]>([]);

  const addFilter = useCallback((value: string) => {
    const v = value.trim();
    if (!v) return;
    setFilters((fs) => (fs.some((f) => f.value.toLowerCase() === v.toLowerCase()) ? fs : [...fs, { id: `f${Date.now()}${Math.random()}`, value: v }]));
  }, []);
  const removeFilter = useCallback((id: string) => setFilters((fs) => fs.filter((f) => f.id !== id)), []);
  const addFocus = useCallback((cls: string) => {
    const v = cls.trim();
    if (!v) return;
    setFocusClasses((cs) => (cs.some((c) => c.toLowerCase() === v.toLowerCase()) ? cs : [...cs, v]));
  }, []);
  const removeFocus = useCallback((cls: string) => setFocusClasses((cs) => cs.filter((c) => c !== cls)), []);

  // Reset the per-trace view state (open frames, selection) for a result.
  const primeView = useCallback((r: ParseResponse) => {
    const open = new Set<string>();
    const idx = indexTree(r.root);
    for (const [id, node] of idx.byId) if (node.onPath) open.add(id);
    const markDepth = (n: typeof r.root, d: number) => {
      if (d < 2) open.add(n.id);
      n.children.forEach((c) => markDepth(c, d + 1));
    };
    markDepth(r.root, 0);
    setOpenIds(open);
    setSelId(r.exception?.id ?? r.root.children[0]?.id ?? r.root.id);
    setQuery("");
    setFilters([]);
    setFocusClasses([]);
    setTrackName(null);
  }, []);

  const handleFile = useCallback(
    async (file: File) => {
      setBusy(true);
      setBusyFile(file.name);
      setError(null);
      try {
        const r = await parseLogFile(file, homeNs);
        const session: Session = {
          id: `s${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
          fileName: file.name,
          fileSize: file.size,
          file,
          homeNs,
          result: r,
          status: statusOf(r),
        };
        setSessions((prev) => [session, ...prev]);
        setActiveId(session.id);
        primeView(r);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setBusy(false);
        setBusyFile(null);
      }
    },
    [homeNs, primeView],
  );

  const selectSession = useCallback(
    (id: string) => {
      const s = sessions.find((x) => x.id === id);
      if (!s) return;
      setActiveId(id);
      primeView(s.result);
    },
    [sessions, primeView],
  );

  const closeSession = useCallback(
    (id: string) => {
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== id);
        if (id === activeId) {
          const fallback = next[0];
          setActiveId(fallback?.id ?? null);
          if (fallback) primeView(fallback.result);
        }
        return next;
      });
    },
    [activeId, primeView],
  );

  const onConnectRepo = useCallback(async () => {
    if (!repoUrl.trim()) return;
    setError(null);
    const branch = repoBranch.trim() || "main";
    setRepoCloning(`${repoUrl.trim()} · branch: ${branch}`);
    try {
      const info = await connectRepo({ url: repoUrl.trim(), token: repoToken.trim(), branch });
      setRepos((prev) => ({
        ...prev,
        [info.repoId]: { url: repoUrl.trim(), branch: info.branch ?? branch, classCount: info.classCount },
      }));
      setRepoUrl("");
      setRepoToken("");
      setRepoBranch("main");
      if (sessions.length > 0) {
        const reparsed = await Promise.all(
          sessions.map(async (s) => {
            try {
              const r = await parseLogFile(s.file, s.homeNs);
              return { ...s, result: r, status: statusOf(r) };
            } catch {
              return s;
            }
          }),
        );
        setSessions(reparsed);
        const active = reparsed.find((s) => s.id === activeId);
        if (active) primeView(active.result);
      }
    } catch (e) {
      setError(`Repo: ${(e as Error).message}`);
    } finally {
      setRepoCloning(null);
    }
  }, [repoUrl, repoToken, repoBranch, sessions, activeId, primeView]);

  const onDisconnectRepo = useCallback(async (repoId: string) => {
    await disconnectRepo(repoId);
    setRepos((prev) => {
      const next = { ...prev };
      delete next[repoId];
      return next;
    });
  }, []);

  const toggle = useCallback((id: string) => {
    setOpenIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
    setExpandAll(false);
  }, []);

  const selectAndReveal = useCallback(
    (id: string) => {
      setSelId(id);
      if (result) {
        const idx = indexTree(result.root);
        let cur = idx.parent.get(id) ?? null;
        setOpenIds((prev) => {
          const next = new Set(prev);
          while (cur) {
            next.add(cur);
            cur = idx.parent.get(cur) ?? null;
          }
          return next;
        });
      }
    },
    [result],
  );

  const timeline = useMemo(
    () => (result && trackName ? valueTimeline(result.root, trackName) : []),
    [result, trackName],
  );

  // The tree the views render: hidden modules spliced out, then pruned to the
  // focus-area classes (if any).
  const viewRoot = useMemo(() => {
    if (!result) return null;
    return focusTree(filterTree(result.root, filters), focusClasses);
  }, [result, filters, focusClasses]);

  // Keep the selection valid against the pruned view.
  const safeSelId = useMemo(() => {
    if (!viewRoot || !selId) return selId;
    return indexTree(viewRoot).byId.has(selId) ? selId : (viewRoot.children[0]?.id ?? null);
  }, [viewRoot, selId]);

  if (!result) {
    return (
      <div className="app">
        <Header
          homeNs={homeNs} setHomeNs={setHomeNs}
          repoUrl={repoUrl} setRepoUrl={setRepoUrl}
          repoToken={repoToken} setRepoToken={setRepoToken}
          repoBranch={repoBranch} setRepoBranch={setRepoBranch}
          repos={repos} onConnectRepo={onConnectRepo} onDisconnectRepo={onDisconnectRepo}
          theme={theme} onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        />
        <div
          className={`dropzone ${drag ? "drag" : ""}`}
          onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
        >
          <div className="big">Symphonix Log Lens</div>
          <div className="sub">Drop a Salesforce FINEST debug log — or click to browse</div>
          <label className="upload-btn">
            <span className="upload-icon">⬆</span>
            Upload Debug Log
            <input type="file" hidden onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])} />
          </label>
          <ul className="landing-points">
            <li>Turns any FINEST debug log into a clickable <b>call tree</b> with timing and values</li>
            <li>Marks managed-package calls as <b>black boxes</b> — honest about what Salesforce hides</li>
            <li><b>Hide noise</b> (e.g. clcommon) or <b>focus</b> on one class to cut through large traces</li>
            <li><b>Track any variable</b> across the entire run to see exactly where a value went wrong</li>
            <li>Load <b>multiple logs</b> side-by-side — Failed / Slow / OK badges at a glance</li>
          </ul>
          <div className="landing-ns">home namespace = <b>{homeNs}</b> · change in header if needed</div>
          {error && <div className="err">{error}</div>}
        </div>
        {busy && <ParseOverlay fileName={busyFile} />}
        {repoCloning && <ParseOverlay title="Connecting repository…" hint={`Sparse-cloning Apex classes from ${repoCloning}`} />}
      </div>
    );
  }

  const total = result.stats.durationNanos ?? 1;
  const baseline = result.stats.baselineNanos ?? 0;
  const exc = result.exception;

  return (
    <div className="app">
      {busy && <ParseOverlay fileName={busyFile} />}
      {repoCloning && <ParseOverlay title="Connecting repository…" hint={`Sparse-cloning Apex classes from ${repoCloning}`} />}
      <Header
        homeNs={homeNs} setHomeNs={setHomeNs}
        repoUrl={repoUrl} setRepoUrl={setRepoUrl}
        repoToken={repoToken} setRepoToken={setRepoToken}
        repoBranch={repoBranch} setRepoBranch={setRepoBranch}
        repos={repos} onConnectRepo={onConnectRepo} onDisconnectRepo={onDisconnectRepo}
        meta={{
          name: result.codeUnit ?? "execution",
          sub: `${result.apiVersion} · ${result.user ?? "—"} · ${fmtDuration(result.stats.durationNanos)} · ${result.stats.methodCalls} calls`,
        }}
        theme={theme}
        onToggleTheme={() => setTheme((t) => (t === "dark" ? "light" : "dark"))}
        onUpload={handleFile}
        onNew={() => { setSessions([]); setActiveId(null); setSelId(null); setQuery(""); setTrackName(null); setFilters([]); setFocusClasses([]); }}
      />

      {exc && (
        <div className="xbanner">
          <span className="pulse" />
          <div className="xt">
            <b>{exc.exceptionType}</b> <span>· {exc.exceptionMessage} · </span>
            <b style={{ color: "var(--text)" }}>{exc.className ?? ""}</b>
            {exc.line != null && <span> · line {exc.line}</span>}
          </div>
          <button className="btn ember" onClick={() => selectAndReveal(exc.id)}>Trace to exception ↓</button>
        </div>
      )}

      <div className="flamewrap">
        <div className="flamehead">
          <button className="flametgl" onClick={() => setShowFlame((v) => !v)}>
            {showFlame ? "−" : "+"}
          </button>
          <span className="t">Transaction waterfall</span>
          <span className="ticks">
            {showFlame
              ? `by class · self-time · 0 ms ─ ${fmtDuration(result.stats.durationNanos)}`
              : `collapsed · ${fmtDuration(result.stats.durationNanos)} total`}
          </span>
        </div>
        {showFlame && (
          <Waterfall
            root={viewRoot ?? result.root}
            baseline={baseline}
            total={total}
            selId={safeSelId}
            onSelect={selectAndReveal}
          />
        )}
      </div>

      <GovernorLimits summary={result.limitsSummary} show={showLimits} onToggle={() => setShowLimits((v) => !v)} />

      <HeroStrip session={sessions.find((s) => s.id === activeId)!} result={result} />

      <FilterFocusBar
        filters={filters}
        onAddFilter={addFilter}
        onRemoveFilter={removeFilter}
        focusClasses={focusClasses}
        onAddFocus={addFocus}
        onRemoveFocus={removeFocus}
      />

      <main
        className="with-rail"
        style={{
          gridTemplateColumns: `230px ${treeWidth ? `${treeWidth}px` : "minmax(380px,1fr)"} 6px 1fr`,
        }}
      >
        <SessionRail
          sessions={sessions}
          activeId={activeId}
          onSelect={selectSession}
          onClose={closeSession}
        />
        <section className="tree-pane">
          <div className="toolbar">
            <div className="search">⌕<input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by class, method or SOQL…" /></div>
            {result.stats.hasException && (
              <button className={`tgl ${pathOnly ? "on" : ""}`} onClick={() => setPathOnly((v) => !v)}>Exception path only</button>
            )}
            <button className={`tgl ${expandAll ? "on" : ""}`} onClick={() => setExpandAll((v) => !v)}>
              {expandAll ? "Collapse" : "Expand all"}
            </button>
          </div>
          <TraceTree
            root={viewRoot ?? result.root}
            total={total}
            selId={safeSelId}
            query={query}
            pathOnly={pathOnly}
            expandAll={expandAll}
            openIds={openIds}
            onToggle={toggle}
            onSelect={selectAndReveal}
            onFocusClass={addFocus}
          />
          <div className="legend">
            <span><i style={{ background: "var(--mth)" }} />Method</span>
            <span><i style={{ background: "var(--cls)" }} />Constructor</span>
            {result.stats.hasSoql && <span><i style={{ background: "var(--soql)" }} />SOQL</span>}
            {result.stats.hasDml && <span><i style={{ background: "var(--dml)" }} />DML</span>}
            <span><i style={{ background: "var(--violet)" }} />🔒 Managed package (opaque)</span>
            {result.stats.hasException && <span><i style={{ background: "var(--ember)" }} />Exception path</span>}
          </div>
        </section>

        <div className="resizer" onMouseDown={startTreeResize} title="drag to resize" />

        {trackName ? (
          <TimelinePane
            name={trackName}
            entries={timeline}
            onClose={() => setTrackName(null)}
            onJump={(id) => { setTrackName(null); selectAndReveal(id); }}
          />
        ) : (
          <Inspector root={viewRoot ?? result.root} selId={safeSelId} total={total} onSelect={selectAndReveal} onTrack={setTrackName} onFocusClass={addFocus} />
        )}
      </main>
    </div>
  );
}

function Header({
  homeNs, setHomeNs,
  repoUrl, setRepoUrl,
  repoToken, setRepoToken,
  repoBranch, setRepoBranch,
  repos, onConnectRepo, onDisconnectRepo,
  meta, onNew, onUpload, theme, onToggleTheme,
}: {
  homeNs: string; setHomeNs: (s: string) => void;
  repoUrl: string; setRepoUrl: (s: string) => void;
  repoToken: string; setRepoToken: (s: string) => void;
  repoBranch: string; setRepoBranch: (s: string) => void;
  repos: Record<string, { url: string; branch: string; classCount: number }>;
  onConnectRepo: () => void;
  onDisconnectRepo: (repoId: string) => void;
  meta?: { name: string; sub: string };
  onNew?: () => void;
  onUpload?: (f: File) => void;
  theme: Theme;
  onToggleTheme: () => void;
}) {
  const [repoOpen, setRepoOpen] = useState(false);
  const repoCount = Object.keys(repos).length;

  return (
    <header>
      <div className="logo"><span className="spark" />Symphonix <em>Log Lens</em></div>
      {meta && (
        <div className="logmeta">
          <div className="name">{meta.name}</div>
          <div className="sub">{meta.sub}</div>
        </div>
      )}
      <div className="hdr-controls">
        <button className="btn theme-btn" onClick={onToggleTheme}>
          {theme === "dark" ? "☀ Light" : "☾ Dark"}
        </button>
        <input value={homeNs} onChange={(e) => setHomeNs(e.target.value)} placeholder="home ns" size={6} title="home namespace" />

        {/* Repo connect — popover with connected repo list + add new form */}
        <div className="repo-wrap">
          <button
            className={`btn ${repoCount > 0 ? "btn-connected" : ""}`}
            onClick={() => setRepoOpen((o) => !o)}
          >
            {repoCount > 0 ? `⎇ ${repoCount} repo${repoCount > 1 ? "s" : ""}` : "connect repo"}
          </button>
          {repoOpen && (
            <div className="repo-popover">
              {/* Connected repos list */}
              {repoCount > 0 && (
                <div className="repo-list">
                  {Object.entries(repos).map(([repoId, r]) => {
                    const repoName = r.url.replace(/^https?:\/\/github\.com\//, "");
                    return (
                      <div key={repoId} className="repo-list-row">
                        <span className="repo-list-name" title={r.url}>⎇ {repoName}</span>
                        <span className="repo-list-meta">{r.branch} · {r.classCount} classes</span>
                        <button className="repo-list-remove" title="disconnect" onClick={() => onDisconnectRepo(repoId)}>×</button>
                      </div>
                    );
                  })}
                  <div className="repo-list-divider" />
                </div>
              )}
              {/* Add new repo */}
              <div className="repo-field">
                <label>Repo URL</label>
                <input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/org/repo" />
              </div>
              <div className="repo-field">
                <label>Personal Access Token</label>
                <input type="password" value={repoToken} onChange={(e) => setRepoToken(e.target.value)} placeholder="ghp_…" />
              </div>
              <div className="repo-field">
                <label>Branch / Tag <span className="repo-field-req">(required)</span></label>
                <input value={repoBranch} onChange={(e) => setRepoBranch(e.target.value)} placeholder="main" />
              </div>
              <button
                className="btn btn-full"
                disabled={!repoUrl.trim() || !repoToken.trim() || !repoBranch.trim()}
                onClick={() => { onConnectRepo(); setRepoOpen(false); }}
              >
                + Clone &amp; index .cls files
              </button>
            </div>
          )}
        </div>

        {onUpload && (
          <label className="btn">
            + log
            <input type="file" hidden onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])} />
          </label>
        )}
        {onNew && <button className="btn" onClick={onNew}>clear all</button>}
      </div>
    </header>
  );
}

function SessionRail({
  sessions, activeId, onSelect, onClose,
}: {
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
}) {
  const counts = {
    failed: sessions.filter((s) => s.status === "failed").length,
    slow: sessions.filter((s) => s.status === "slow").length,
  };
  return (
    <aside className="rail">
      <div className="rail-head">
        <span className="rail-title">Trace sessions</span>
        {counts.failed > 0 && <span className="sbadge failed">{counts.failed} failed</span>}
        {counts.failed === 0 && counts.slow > 0 && <span className="sbadge slow">{counts.slow} slow</span>}
      </div>
      <div className="rail-body">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`tcard ${s.id === activeId ? "active" : ""}`}
            onClick={() => onSelect(s.id)}
          >
            <div className="tcard-top">
              <span className="tcard-name" title={s.fileName}>{s.fileName}</span>
              <span className={`sbadge ${s.status}`}>{s.status}</span>
            </div>
            <div className="tcard-sub">
              {s.result.codeUnit ?? "execution"}
            </div>
            <div className="tcard-meta">
              <span>{fmtDuration(s.result.stats.durationNanos)}</span>
              <span>{s.result.stats.methodCalls} calls</span>
              <button className="tcard-x" title="close" onClick={(e) => { e.stopPropagation(); onClose(s.id); }}>✕</button>
            </div>
          </div>
        ))}
      </div>
    </aside>
  );
}

function GovernorLimits({ summary, show, onToggle }: { summary: LimitsSummary; show: boolean; onToggle: () => void }) {
  if (!summary?.rows) return null; // defensive: session parsed by an older server
  const allZero = summary.rows.every((r) => r.used === 0);
  const peak = summary.rows.length > 0 ? Math.max(...summary.rows.map((r) => (r.used / r.max) * 100)) : 0;
  const peakTone = peak >= 90 ? "red" : peak >= 50 ? "orange" : "green";

  return (
    <div className="limitwrap">
      <div className="limithead">
        <button className="flametgl" onClick={onToggle}>{show ? "−" : "+"}</button>
        <span className="t">Governor limits</span>
        <span className={`lim-context ${summary.context}`}>{summary.contextLabel}</span>
        <span className="ticks">
          {summary.source === "logged" ? "from log" : "estimated from counted events"}
          {!show && summary.rows.length > 0 && (
            <> · peak <b className={`lim-pct ${peakTone}`}>{peak.toFixed(0)}%</b></>
          )}
        </span>
      </div>
      {show && (
        summary.source === "estimated" && allZero ? (
          <div className="lim-hint">
            <div>This log doesn't record any limit-relevant events, so usage can't be shown.</div>
            <div style={{ marginTop: 8 }}>
              To capture governor limits, set these debug levels and re-run:
            </div>
            <div className="lim-levels">
              <span><b>Apex Code</b> = FINEST</span>
              <span><b>Database</b> = FINEST</span>
              <span><b>Profiling</b> = FINEST</span>
            </div>
            <div style={{ marginTop: 6, color: "var(--faint)" }}>
              Profiling gives the full set of 13 limits exactly; Database alone gives SOQL/DML/callout counts.
            </div>
          </div>
        ) : (
          <div className="limgrid">
            {summary.rows.map((r) => {
              const pct = Math.min(100, (r.used / r.max) * 100);
              const tone = pct >= 90 ? "red" : pct >= 50 ? "orange" : "green";
              return (
                <div className="limcard" key={r.key}>
                  <div className="limcard-top">
                    <span className="limk" title={r.key}>{r.key}</span>
                    <span className={`limv ${tone}`}>{r.used.toLocaleString()}<span className="limmax">/{r.max.toLocaleString()}</span></span>
                  </div>
                  <div className="limbar"><i className={tone} style={{ width: `${Math.max(2, pct)}%` }} /></div>
                </div>
              );
            })}
          </div>
        )
      )}
    </div>
  );
}

function HeroStrip({ session, result }: { session: Session; result: ParseResponse }) {
  const sizeMB = session ? (session.fileSize / 1e6).toFixed(1) : "—";
  let depth = 0;
  const walk = (n: ParseResponse["root"], d: number) => { depth = Math.max(depth, d); n.children.forEach((c) => walk(c, d + 1)); };
  walk(result.root, 0);
  const outcome = !session ? "—" : session.status === "failed" ? "Failed" : session.status === "slow" ? "Slow" : "OK";
  const outcomeColor = session?.status === "failed" ? "var(--ember)" : session?.status === "slow" ? "var(--dml)" : "var(--cls)";
  return (
    <div className="herostrip">
      <Metric label="Outcome" value={outcome} color={outcomeColor} />
      <Metric label="Duration" value={fmtDuration(result.stats.durationNanos)} />
      <Metric label="Log size" value={`${sizeMB} MB`} />
      <Metric label="Method calls" value={String(result.stats.methodCalls)} />
      <Metric label="Call depth" value={`${depth}`} />
      <Metric label="Blind spots" value={`${result.stats.managedPkgRuns} pkg`} />
    </div>
  );
}

function Metric({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="metric">
      <span className="mk">{label}</span>
      <strong className="mv" style={color ? { color } : undefined}>{value}</strong>
    </div>
  );
}

const HIDE_PRESETS = ["clcommon", "PlatformLog", "LogUtil", "CustomSettingsUtil"];

function FilterFocusBar({
  filters, onAddFilter, onRemoveFilter, focusClasses, onAddFocus, onRemoveFocus,
}: {
  filters: Filter[];
  onAddFilter: (v: string) => void;
  onRemoveFilter: (id: string) => void;
  focusClasses: string[];
  onAddFocus: (v: string) => void;
  onRemoveFocus: (v: string) => void;
}) {
  const [hideText, setHideText] = useState("");
  const [focusText, setFocusText] = useState("");
  const activeHide = new Set(filters.map((f) => f.value.toLowerCase()));

  return (
    <div className="ffbar">
      <div className="ffgroup">
        <span className="fflabel">Focus area</span>
        <input
          className="ffinput"
          value={focusText}
          placeholder="drop a class to debug just that…  (e.g. RateMatrix)"
          onChange={(e) => setFocusText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { onAddFocus(focusText); setFocusText(""); } }}
        />
        {focusClasses.map((c) => (
          <span key={c} className="ffchip focus">
            {c}<button onClick={() => onRemoveFocus(c)}>✕</button>
          </span>
        ))}
        {focusClasses.length === 0 && <span className="ffhint">whole trace</span>}
      </div>

      <div className="ffsep" />

      <div className="ffgroup">
        <span className="fflabel">Hide</span>
        <input
          className="ffinput"
          value={hideText}
          placeholder="class / method / namespace…  (e.g. clcommon, *Logger)"
          onChange={(e) => setHideText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { onAddFilter(hideText); setHideText(""); } }}
        />
        {HIDE_PRESETS.filter((p) => !activeHide.has(p.toLowerCase())).map((p) => (
          <button key={p} className="ffpreset" onClick={() => onAddFilter(p)}>+ {p}</button>
        ))}
        {filters.map((f) => (
          <span key={f.id} className="ffchip hide">
            {f.value}<button onClick={() => onRemoveFilter(f.id)}>✕</button>
          </span>
        ))}
      </div>
    </div>
  );
}

function TimelinePane({
  name, entries, onClose, onJump,
}: {
  name: string;
  entries: ReturnType<typeof valueTimeline>;
  onClose: () => void;
  onJump: (id: string) => void;
}) {
  return (
    <aside className="insp">
      <div className="sig" style={{ paddingTop: 14 }}>
        <h2>Timeline · <span className="cls">{name}</span></h2>
        <div className="meta">
          <span>{entries.length} assignment{entries.length === 1 ? "" : "s"} across the run</span>
          <button className="btn" style={{ marginLeft: "auto" }} onClick={onClose}>← back to frame</button>
        </div>
      </div>
      <div className="ibody">
        {entries.length === 0 ? (
          <div className="empty">No assignments to “{name}”.</div>
        ) : (
          entries.map((e, i) => (
            <div key={i} className="tl-row2">
              <span style={{ color: "var(--faint)", minWidth: 22 }}>{i + 1}</span>
              <span className="owner" onClick={() => onJump(e.node.id)}>{e.ownerLabel}</span>
              {e.line != null && <span className="bdg">L{e.line}</span>}
              <span style={{ flex: 1 }} />
              <span className={e.changed ? "chg" : ""}>{e.changed ? "● " : ""}{e.value.length > 60 ? e.value.slice(0, 60) + "…" : e.value}</span>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

function ParseOverlay({
  fileName,
  title = "Analysing log…",
  hint = "Building call tree · extracting values · mapping managed packages",
}: {
  fileName?: string | null;
  title?: string;
  hint?: string;
}) {
  return (
    <div className="parse-overlay">
      <div className="parse-card">
        <div className="parse-spinner" />
        <div className="parse-title">{title}</div>
        {fileName && <div className="parse-file">{fileName}</div>}
        <div className="parse-bar"><div className="parse-bar-fill" /></div>
        <div className="parse-hint">{hint}</div>
      </div>
    </div>
  );
}

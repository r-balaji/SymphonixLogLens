import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseLog } from "../shared/parser.js";
import type { CallNode, ParseResult } from "../shared/types.js";
import { RepoIndex } from "./repo.js";
import { sparseClone, verifyAccess, removeTmpDir, cleanupStaleClones } from "./git-clone.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "../dist");

const PORT = Number(process.env.PORT ?? 8787);
const app = express();
app.use(cors({ exposedHeaders: ["x-session-id"] }));
app.use(express.json({ limit: "2mb" }));

// In-memory upload, up to 30MB (SF caps a single log at ~20MB).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
});

/**
 * Deduplicated, reference-counted repo cache.
 *
 * A repo is cloned ONCE per (url+branch), keyed by `repoId`, and shared across
 * every session that connects it — so 100 users connecting loan/master produce
 * ONE clone, not 100. Each repo carries a `refs` set of the session ids
 * currently using it (the dedup + authorization list): a session can only read
 * source from repos it has attached to, and attaching to an already-cloned repo
 * still requires a passing `ls-remote` token check (share the bytes, never the
 * access). A repo is evicted once its last user leaves. Clones live in /tmp and
 * are wiped on eviction or process restart; nothing is persisted.
 */
interface RepoEntry {
  index: RepoIndex;
  tmpDir?: string; // present for cloned (GitHub) repos; absent for local paths
  url?: string; // for re-verifying access on later attaches
  branch?: string;
  isGit: boolean;
  refs: Set<string>; // session ids currently using this repo
}

const repos = new Map<string, RepoEntry>(); // repoId -> entry (shared across sessions)
const sessions = new Map<string, number>(); // sessionId -> lastSeen
const SESSION_TTL_MS = 60 * 60 * 1000; // a session idle 1h releases its repo refs

function sessionIdOf(req: express.Request): string {
  return String(req.header("x-session-id") || "shared");
}

function touch(id: string): void {
  sessions.set(id, Date.now());
}

async function evictIfUnused(repoId: string): Promise<void> {
  const entry = repos.get(repoId);
  if (entry && entry.refs.size === 0) {
    if (entry.tmpDir) await removeTmpDir(entry.tmpDir);
    repos.delete(repoId);
  }
}

// Periodically release refs held by idle sessions, then evict repos nobody uses.
setInterval(() => {
  const now = Date.now();
  for (const [id, lastSeen] of sessions) {
    if (now - lastSeen > SESSION_TTL_MS) {
      sessions.delete(id);
      for (const entry of repos.values()) entry.refs.delete(id);
    }
  }
  for (const repoId of [...repos.keys()]) void evictIfUnused(repoId);
}, 10 * 60 * 1000).unref();

function makeRepoId(url: string, branch: string): string {
  return Buffer.from(`${url}::${branch}`).toString("base64url");
}

/** Attach a session to source links, using only repos this session is authorized for. */
function enrichWithSource(node: CallNode, home: string, sessionId: string): void {
  if (node.className && (node.namespace === home || node.namespace === null)) {
    for (const [repoId, entry] of repos) {
      if (!entry.index.isReady() || !entry.refs.has(sessionId)) continue;
      const rel = entry.index.resolve(node.className);
      if (rel) {
        node.sourceFile = rel;
        node.sourceUrl = `/api/source?repo=${encodeURIComponent(repoId)}&path=${encodeURIComponent(rel)}${
          node.method ? `&method=${encodeURIComponent(node.method)}` : ""
        }`;
        break; // first match wins
      }
    }
  }
  for (const c of node.children) enrichWithSource(c, home, sessionId);
}

app.post("/api/parse", upload.single("log"), (req, res) => {
  try {
    const homeNamespace = String(req.body.homeNamespace ?? "loan").trim();
    let text: string;
    if (req.file) {
      text = req.file.buffer.toString("utf8");
    } else if (typeof req.body.text === "string") {
      text = req.body.text;
    } else {
      return res.status(400).json({ error: "No log file or text provided." });
    }

    const started = Date.now();
    const sessionId = sessionIdOf(req);
    touch(sessionId);
    const result: ParseResult = parseLog(text, { homeNamespace });
    if (repos.size > 0) enrichWithSource(result.root, homeNamespace, sessionId);
    const parseMs = Date.now() - started;

    res.json({ ...result, parseMs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/repo", async (req, res) => {
  try {
    const sessionId = sessionIdOf(req);
    touch(sessionId);
    const url = String(req.body.url ?? "").trim();
    const token = String(req.body.token ?? "").trim();
    const branch = String(req.body.branch ?? "main").trim() || "main";
    const localPath = String(req.body.path ?? "").trim();

    if (url) {
      if (!token) return res.status(400).json({ error: "A Personal Access Token is required for GitHub repos." });

      const repoId = makeRepoId(url, branch);
      const existing = repos.get(repoId);
      if (existing?.index.isReady()) {
        // Already cloned by someone — share the bytes, but this session must
        // still prove its token can reach the repo before we attach it.
        await verifyAccess(url, token, branch);
        existing.refs.add(sessionId);
        return res.json({ ok: true, repoId, classCount: existing.index.classCount, root: url, branch });
      }

      // First requester clones it once; everyone after reuses this.
      const { tmpDir, classCount } = await sparseClone(url, token, branch);
      const index = new RepoIndex(tmpDir);
      await index.build();
      repos.set(repoId, { index, tmpDir, url, branch, isGit: true, refs: new Set([sessionId]) });

      return res.json({ ok: true, repoId, classCount, root: url, branch });
    } else if (localPath) {
      // Local path (dev / localhost only). No clone, no token check.
      const repoId = makeRepoId(localPath, "local");
      const existing = repos.get(repoId);
      if (existing?.index.isReady()) {
        existing.refs.add(sessionId);
        return res.json({ ok: true, repoId, classCount: existing.index.classCount, root: localPath });
      }
      const index = new RepoIndex(localPath);
      const info = await index.build();
      repos.set(repoId, { index, isGit: false, refs: new Set([sessionId]) });
      return res.json({ ok: true, repoId, ...info });
    } else {
      return res.status(400).json({ error: "Provide a GitHub repo URL or a local path." });
    }
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.delete("/api/repo/:repoId", async (req, res) => {
  const sessionId = sessionIdOf(req);
  touch(sessionId);
  const entry = repos.get(req.params.repoId);
  if (entry) {
    entry.refs.delete(sessionId);
    await evictIfUnused(req.params.repoId); // last user out wipes the clone
  }
  res.json({ ok: true });
});

app.get("/api/source", async (req, res) => {
  try {
    const sessionId = sessionIdOf(req);
    touch(sessionId);
    const repoId = req.query.repo ? String(req.query.repo) : null;
    const rel = String(req.query.path ?? "");
    const method = req.query.method ? String(req.query.method) : null;

    // Resolve the repo, but only if THIS session is attached to it.
    const entry = repoId
      ? repos.get(repoId)
      : [...repos.values()].find((e) => e.refs.has(sessionId));

    if (!entry?.index.isReady() || !entry.refs.has(sessionId)) {
      return res.status(403).json({ error: "No repo connected for this session." });
    }
    const { content, methodLine } = await entry.index.findMethodLine(rel, method);
    res.json({ path: rel, methodLine, content });
  } catch (err) {
    res.status(404).json({ error: (err as Error).message });
  }
});

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// Serve the Vite build in production. In dev, Vite's own server handles the frontend.
if (process.env.NODE_ENV === "production") {
  app.use(express.static(DIST));
  app.get("*", (_req, res) => res.sendFile(path.join(DIST, "index.html")));
}

app.listen(PORT, async () => {
  console.log(`LogPlayBook server listening on http://localhost:${PORT}`);
  const removed = await cleanupStaleClones();
  if (removed > 0) console.log(`Cleaned up ${removed} stale repo clone(s) from a previous run.`);
});

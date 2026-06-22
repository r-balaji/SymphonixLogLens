import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseLog } from "../shared/parser.js";
import type { CallNode, ParseResult } from "../shared/types.js";
import { RepoIndex } from "./repo.js";
import { sparseClone, removeTmpDir } from "./git-clone.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "../dist");

const PORT = Number(process.env.PORT ?? 8787);
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// In-memory upload, up to 30MB (SF caps a single log at ~20MB).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 },
});

// Multiple repo indexes — keyed by a stable repoId derived from url+branch.
const repoIndexes = new Map<string, RepoIndex>();
const repoTmpDirs = new Map<string, string>();

function makeRepoId(url: string, branch: string): string {
  return Buffer.from(`${url}::${branch}`).toString("base64url").slice(0, 12);
}

/** Walk the tree and attach sourceFile/sourceUrl to each home-namespace node. */
function enrichWithSource(node: CallNode, home: string): void {
  if (node.className && (node.namespace === home || node.namespace === null)) {
    for (const [repoId, index] of repoIndexes) {
      if (!index.isReady()) continue;
      const rel = index.resolve(node.className);
      if (rel) {
        node.sourceFile = rel;
        node.sourceUrl = `/api/source?repo=${encodeURIComponent(repoId)}&path=${encodeURIComponent(rel)}${
          node.method ? `&method=${encodeURIComponent(node.method)}` : ""
        }`;
        break; // first match wins
      }
    }
  }
  for (const c of node.children) enrichWithSource(c, home);
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
    const result: ParseResult = parseLog(text, { homeNamespace });
    if (repoIndexes.size > 0) enrichWithSource(result.root, homeNamespace);
    const parseMs = Date.now() - started;

    res.json({ ...result, parseMs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/repo", async (req, res) => {
  try {
    const url = String(req.body.url ?? "").trim();
    const token = String(req.body.token ?? "").trim();
    const branch = String(req.body.branch ?? "main").trim() || "main";
    const localPath = String(req.body.path ?? "").trim();

    if (url) {
      if (!token) return res.status(400).json({ error: "A Personal Access Token is required for GitHub repos." });

      const repoId = makeRepoId(url, branch);

      // Clean up the previous clone for this same repo/branch if reconnecting.
      const oldTmp = repoTmpDirs.get(repoId);
      if (oldTmp) await removeTmpDir(oldTmp);
      repoTmpDirs.delete(repoId);
      repoIndexes.delete(repoId);

      const { tmpDir, classCount } = await sparseClone(url, token, branch);
      repoTmpDirs.set(repoId, tmpDir);
      const index = new RepoIndex(tmpDir);
      await index.build();
      repoIndexes.set(repoId, index);

      return res.json({ ok: true, repoId, classCount, root: url, branch });
    } else if (localPath) {
      // Local path (dev / localhost only).
      const repoId = makeRepoId(localPath, "local");
      repoIndexes.delete(repoId);
      const index = new RepoIndex(localPath);
      const info = await index.build();
      repoIndexes.set(repoId, index);
      return res.json({ ok: true, repoId, ...info });
    } else {
      return res.status(400).json({ error: "Provide a GitHub repo URL or a local path." });
    }
  } catch (err) {
    res.status(400).json({ error: (err as Error).message });
  }
});

app.delete("/api/repo/:repoId", async (req, res) => {
  const repoId = req.params.repoId;
  const tmpDir = repoTmpDirs.get(repoId);
  if (tmpDir) await removeTmpDir(tmpDir);
  repoTmpDirs.delete(repoId);
  repoIndexes.delete(repoId);
  res.json({ ok: true });
});

app.get("/api/source", async (req, res) => {
  try {
    const repoId = req.query.repo ? String(req.query.repo) : null;
    const rel = String(req.query.path ?? "");
    const method = req.query.method ? String(req.query.method) : null;

    const index = repoId
      ? repoIndexes.get(repoId) ?? null
      : repoIndexes.size > 0 ? repoIndexes.values().next().value : null;

    if (!index?.isReady()) {
      return res.status(400).json({ error: "No repo connected." });
    }
    const { content, methodLine } = await index.findMethodLine(rel, method);
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

app.listen(PORT, () => {
  console.log(`LogPlayBook server listening on http://localhost:${PORT}`);
});

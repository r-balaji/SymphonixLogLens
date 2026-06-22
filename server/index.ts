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

// One repo index per server process (single-user local tool).
let repoIndex: RepoIndex | null = null;
let repoTmpDir: string | null = null; // temp dir from last sparse clone, if any

/** Walk the tree and attach sourceFile to each home-namespace node we can resolve. */
function enrichWithSource(node: CallNode, home: string): void {
  if (
    repoIndex?.isReady() &&
    node.className &&
    (node.namespace === home || node.namespace === null)
  ) {
    const rel = repoIndex.resolve(node.className);
    if (rel) {
      node.sourceFile = rel;
      node.sourceUrl = `/api/source?path=${encodeURIComponent(rel)}${
        node.method ? `&method=${encodeURIComponent(node.method)}` : ""
      }`;
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
    if (repoIndex?.isReady()) enrichWithSource(result.root, homeNamespace);
    const parseMs = Date.now() - started;

    res.json({ ...result, parseMs });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: (err as Error).message });
  }
});

app.post("/api/repo", async (req, res) => {
  // Clean up any previous sparse-clone temp dir.
  if (repoTmpDir) {
    await removeTmpDir(repoTmpDir);
    repoTmpDir = null;
  }
  repoIndex = null;

  try {
    const url = String(req.body.url ?? "").trim();
    const token = String(req.body.token ?? "").trim();
    const branch = String(req.body.branch ?? "main").trim() || "main";
    const localPath = String(req.body.path ?? "").trim();

    let root: string;

    if (url) {
      // GitHub URL + PAT: sparse-clone only .cls files into a temp dir.
      if (!token) return res.status(400).json({ error: "A Personal Access Token is required for GitHub repos." });
      const { tmpDir, classCount } = await sparseClone(url, token, branch);
      repoTmpDir = tmpDir;
      repoIndex = new RepoIndex(tmpDir);
      await repoIndex.build(); // indexes the already-cloned .cls files
      return res.json({ ok: true, classCount, root: url, branch });
    } else if (localPath) {
      // Local path (dev / localhost only).
      root = localPath;
      repoIndex = new RepoIndex(root);
      const info = await repoIndex.build();
      return res.json({ ok: true, ...info });
    } else {
      return res.status(400).json({ error: "Provide a GitHub repo URL or a local path." });
    }
  } catch (err) {
    repoIndex = null;
    repoTmpDir = null;
    res.status(400).json({ error: (err as Error).message });
  }
});

app.get("/api/source", async (req, res) => {
  try {
    if (!repoIndex?.isReady()) {
      return res.status(400).json({ error: "No repo connected." });
    }
    const rel = String(req.query.path ?? "");
    const method = req.query.method ? String(req.query.method) : null;
    const { content, methodLine } = await repoIndex.findMethodLine(rel, method);
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

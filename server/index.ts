import express from "express";
import cors from "cors";
import multer from "multer";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseLog } from "../shared/parser.js";
import type { CallNode, ParseResult } from "../shared/types.js";
import { RepoIndex } from "./repo.js";

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
  try {
    const root = String(req.body.path ?? "").trim();
    if (!root) return res.status(400).json({ error: "Provide a repo path." });
    repoIndex = new RepoIndex(root);
    const info = await repoIndex.build();
    res.json({ ok: true, ...info });
  } catch (err) {
    repoIndex = null;
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

import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Resolves Apex class names to source files in a locally cloned Salesforce repo.
 * Scans for *.cls files once and indexes them by class name (the file basename,
 * which by SFDX convention equals the Apex class name).
 */
export class RepoIndex {
  private root: string;
  private byClassName = new Map<string, string>(); // ClassName -> repo-relative path
  private built = false;

  constructor(root: string) {
    this.root = root;
  }

  async build(): Promise<{ classCount: number; root: string }> {
    // Fail loudly if the path is wrong — otherwise a typo silently looks like
    // a connected repo with zero classes.
    let stat;
    try {
      stat = await fs.stat(this.root);
    } catch {
      throw new Error(`Path not found: ${this.root}`);
    }
    if (!stat.isDirectory()) throw new Error(`Not a directory: ${this.root}`);

    this.byClassName.clear();
    await this.walk(this.root);
    this.built = true;
    if (this.byClassName.size === 0) {
      throw new Error(
        `No .cls files found under ${this.root}. Point at your SFDX repo root (the folder containing force-app/).`,
      );
    }
    return { classCount: this.byClassName.size, root: this.root };
  }

  private async walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name.startsWith(".") || e.name === "node_modules") continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        await this.walk(full);
      } else if (e.isFile() && e.name.endsWith(".cls")) {
        const className = e.name.slice(0, -".cls".length);
        const rel = path.relative(this.root, full);
        // First match wins; SFDX repos rarely have duplicate class names.
        if (!this.byClassName.has(className)) this.byClassName.set(className, rel);
      }
    }
  }

  isReady(): boolean {
    return this.built;
  }

  /** Returns the repo-relative path for a class name, or null. */
  resolve(className: string | null): string | null {
    if (!className) return null;
    return this.byClassName.get(className) ?? null;
  }

  /** Reads a file and finds the line number where a method is declared (best effort). */
  async findMethodLine(
    relPath: string,
    method: string | null,
  ): Promise<{ content: string; methodLine: number | null }> {
    const abs = path.join(this.root, relPath);
    const content = await fs.readFile(abs, "utf8");
    if (!method || method === "<init>") return { content, methodLine: null };
    const lines = content.split(/\r?\n/);
    // Heuristic: first line that contains the method name followed by "(".
    const re = new RegExp(`\\b${escapeRe(method)}\\s*\\(`);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i])) return { content, methodLine: i + 1 };
    }
    return { content, methodLine: null };
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

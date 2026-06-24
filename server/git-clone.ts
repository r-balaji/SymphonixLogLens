import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Sparse-clones only Apex class files from a GitHub repo using a PAT.
 * Uses execFile (no shell) so arguments are passed directly — no quoting issues.
 */
export async function sparseClone(
  repoUrl: string,
  token: string,
  branch: string,
): Promise<{ tmpDir: string; classCount: number }> {
  // Inject the PAT into the HTTPS URL: https://<token>@github.com/org/repo.git
  const authedUrl = repoUrl.replace(/^https?:\/\//, `https://${token}@`);

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "loglens-repo-"));

  try {
    // Step 1: clone without checking out any files, depth 1, sparse mode.
    await execFileAsync("git", [
      "clone", "--depth", "1", "--filter=blob:none", "--sparse",
      "--branch", branch, authedUrl, tmpDir,
    ], { timeout: 120_000 });

    // Step 2: switch to no-cone mode (required for glob patterns).
    await execFileAsync("git", ["-C", tmpDir, "sparse-checkout", "init", "--no-cone"], {
      timeout: 30_000,
    });

    // Step 3: pull only Apex class files (SFDX stores them under **/classes/).
    await execFileAsync("git", ["-C", tmpDir, "sparse-checkout", "set", "**/classes/*.cls"], {
      timeout: 60_000,
    });

    // Count what we got by walking the directory (no shell glob needed).
    const classCount = await countCls(tmpDir);

    if (classCount === 0) {
      throw new Error(
        `No .cls files found in ${repoUrl} (branch: ${branch}). Check the repo URL and branch name.`,
      );
    }

    return { tmpDir, classCount };
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    // execFile puts stderr inside err.stderr — surface it so we can diagnose
    const e = err as Error & { stderr?: string; stdout?: string };
    const detail = e.stderr?.trim() || e.stdout?.trim() || e.message;
    const msg = detail.replace(new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "<token>");
    throw new Error(msg);
  }
}

async function countCls(dir: string): Promise<number> {
  let count = 0;
  const walk = async (d: string) => {
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === ".git") continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && e.name.endsWith(".cls")) count++;
    }
  };
  await walk(dir);
  return count;
}

/**
 * Cheap access check (no clone): can this token reach this repo+branch?
 * Used when a session attaches to an ALREADY-cloned repo in the dedup cache —
 * so we share the bytes but never let someone read a repo their token can't.
 */
export async function verifyAccess(
  repoUrl: string,
  token: string,
  branch: string,
): Promise<void> {
  const authedUrl = repoUrl.replace(/^https?:\/\//, `https://${token}@`);
  try {
    await execFileAsync("git", ["ls-remote", "--heads", authedUrl, branch], {
      timeout: 30_000,
    });
  } catch (err) {
    const e = err as Error & { stderr?: string };
    const detail = (e.stderr?.trim() || e.message).replace(
      new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"),
      "<token>",
    );
    throw new Error(`Access check failed for ${repoUrl} (${branch}): ${detail}`);
  }
}

export async function removeTmpDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

const CLONE_PREFIX = "loglens-repo-";

/**
 * Delete any leftover clone dirs in the temp dir. Called at startup: the
 * in-memory repo map is empty on boot, so every `loglens-repo-*` on disk is a
 * guaranteed orphan from a previous run (a process that died without cleaning
 * up). Without this, orphaned clones accumulate across restarts.
 */
export async function cleanupStaleClones(): Promise<number> {
  const tmp = os.tmpdir();
  let removed = 0;
  let entries: string[] = [];
  try {
    entries = await fs.readdir(tmp);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (name.startsWith(CLONE_PREFIX)) {
      await removeTmpDir(path.join(tmp, name));
      removed++;
    }
  }
  return removed;
}


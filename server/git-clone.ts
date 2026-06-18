import { exec } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

/**
 * Sparse-clones only **.cls files from a GitHub repo using a PAT.
 * Returns the path to the temp directory containing the cloned files.
 * Caller is responsible for cleaning up the directory when done.
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
    await execAsync(
      `git clone --depth 1 --filter=blob:none --sparse --branch ${shellQuote(branch)} ${shellQuote(authedUrl)} ${shellQuote(tmpDir)}`,
      { timeout: 120_000 },
    );

    // Step 2: pull only the classes/ folders (SFDX keeps Apex in **/classes/*.cls).
    // This avoids downloading LWC, static resources, XML metadata, etc.
    await execAsync(`git -C ${shellQuote(tmpDir)} sparse-checkout set "/**/classes/*.cls"`, {
      timeout: 60_000,
    });

    // Count what we got.
    const { stdout } = await execAsync(
      `find ${shellQuote(tmpDir)} -name "*.cls" -not -path "*/.git/*"`,
      { timeout: 30_000 },
    );
    const classCount = stdout.trim().split("\n").filter(Boolean).length;

    if (classCount === 0) {
      throw new Error(
        `No .cls files found in ${repoUrl} (branch: ${branch}). Check the repo URL and branch name.`,
      );
    }

    return { tmpDir, classCount };
  } catch (err) {
    // Clean up on failure so we don't leave temp dirs behind.
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    // Scrub the token from any error message before surfacing it.
    const msg = (err as Error).message.replace(token, "<token>");
    throw new Error(msg);
  }
}

export async function removeTmpDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

/** Minimal shell quoting — wraps in single quotes and escapes internal single quotes. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

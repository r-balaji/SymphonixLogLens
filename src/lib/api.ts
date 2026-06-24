import type { ParseResult } from "../../shared/types.js";

export interface ParseResponse extends ParseResult {
  parseMs: number;
}

/**
 * A per-tab session id, sent as `x-session-id` on every API call. The server
 * scopes cloned repos to this id, so each user's repo state is isolated. Stored
 * in sessionStorage so it survives a reload within the tab but a new tab gets
 * its own session (and its own ephemeral clone).
 */
const SESSION_ID: string = (() => {
  const KEY = "loglens-session";
  try {
    const existing = sessionStorage.getItem(KEY);
    if (existing) return existing;
    const id =
      (crypto as Crypto & { randomUUID?: () => string }).randomUUID?.() ??
      `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    sessionStorage.setItem(KEY, id);
    return id;
  } catch {
    return `s-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }
})();

/** Merge the session header into any fetch init. */
function withSession(init: RequestInit = {}): RequestInit {
  return { ...init, headers: { ...(init.headers ?? {}), "x-session-id": SESSION_ID } };
}

export async function parseLogFile(
  file: File,
  homeNamespace: string,
): Promise<ParseResponse> {
  const form = new FormData();
  form.append("log", file);
  form.append("homeNamespace", homeNamespace);
  const res = await fetch("/api/parse", withSession({ method: "POST", body: form }));
  if (!res.ok) throw new Error((await res.json()).error ?? "Parse failed");
  return res.json();
}

export async function connectRepo(opts: {
  url?: string;
  token?: string;
  branch?: string;
  path?: string;
}): Promise<{ ok: true; repoId: string; classCount: number; root: string; branch?: string }> {
  const res = await fetch(
    "/api/repo",
    withSession({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts),
    }),
  );
  if (!res.ok) throw new Error((await res.json()).error ?? "Repo connect failed");
  return res.json();
}

export async function disconnectRepo(repoId: string): Promise<void> {
  await fetch(`/api/repo/${encodeURIComponent(repoId)}`, withSession({ method: "DELETE" }));
}

export async function fetchSource(
  url: string,
): Promise<{ path: string; methodLine: number | null; content: string }> {
  const res = await fetch(url, withSession());
  if (!res.ok) throw new Error((await res.json()).error ?? "Source fetch failed");
  return res.json();
}

import type { ParseResult } from "../../shared/types.js";

export interface ParseResponse extends ParseResult {
  parseMs: number;
}

export async function parseLogFile(
  file: File,
  homeNamespace: string,
): Promise<ParseResponse> {
  const form = new FormData();
  form.append("log", file);
  form.append("homeNamespace", homeNamespace);
  const res = await fetch("/api/parse", { method: "POST", body: form });
  if (!res.ok) throw new Error((await res.json()).error ?? "Parse failed");
  return res.json();
}

export async function connectRepo(
  path: string,
): Promise<{ ok: true; classCount: number; root: string }> {
  const res = await fetch("/api/repo", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  });
  if (!res.ok) throw new Error((await res.json()).error ?? "Repo connect failed");
  return res.json();
}

export async function fetchSource(
  url: string,
): Promise<{ path: string; methodLine: number | null; content: string }> {
  const res = await fetch(url);
  if (!res.ok) throw new Error((await res.json()).error ?? "Source fetch failed");
  return res.json();
}

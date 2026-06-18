/** Human-friendly duration from nanoseconds. */
export function fmtDuration(nanos: number | null): string {
  if (nanos === null) return "";
  const ms = nanos / 1e6;
  if (ms < 1) return `${(nanos / 1e3).toFixed(0)}µs`;
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Truncate long values (JSON snapshots etc.) for chip display. */
export function truncate(s: string, max = 80): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}

/** Pretty-print a value if it looks like JSON; otherwise return as-is. */
export function maybePretty(value: string): string {
  const parsed = tryParse(value);
  return parsed === undefined ? value : JSON.stringify(parsed, null, 2);
}

function tryParse(value: string): unknown {
  const t = value.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      return JSON.parse(t);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export type ValueShape =
  | { kind: "object"; fields: number; summary: string; pretty: string }
  | { kind: "array"; length: number; summary: string; pretty: string }
  | { kind: "null" }
  | { kind: "bool"; text: string }
  | { kind: "number"; text: string }
  | { kind: "string"; text: string }
  | { kind: "raw"; text: string };

/**
 * Classify a logged value so the UI can show a compact summary (e.g.
 * "{ 60 fields }") and only expand the full JSON on demand.
 */
export function classifyValue(value: string): ValueShape {
  const t = value.trim();
  if (t === "null") return { kind: "null" };
  if (t === "true" || t === "false") return { kind: "bool", text: t };

  const parsed = tryParse(value);
  if (parsed && typeof parsed === "object") {
    const pretty = JSON.stringify(parsed, null, 2);
    if (Array.isArray(parsed)) {
      return {
        kind: "array",
        length: parsed.length,
        summary: parsed.length === 0 ? "[ ]" : `[ ${parsed.length} items ]`,
        pretty,
      };
    }
    const fields = Object.keys(parsed as object).length;
    return {
      kind: "object",
      fields,
      summary: fields === 0 ? "{ }" : `{ ${fields} field${fields === 1 ? "" : "s"} }`,
      pretty,
    };
  }

  if (/^-?\d+(\.\d+)?$/.test(t)) return { kind: "number", text: t };
  if (t.startsWith('"') && t.endsWith('"')) return { kind: "string", text: t.slice(1, -1) };
  return { kind: "raw", text: value };
}

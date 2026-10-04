/**
 * Command parser. Pure function from a line to a `ParsedCommand`.
 */

export interface ParsedCommand {
  name: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseCommand(line: string): ParsedCommand {
  const trimmed = line.trim();
  if (!trimmed) return { name: "", positional: [], flags: {} };
  const tokens = tokenize(trimmed);
  if (tokens.length === 0) return { name: "", positional: [], flags: {} };

  const name = tokens[0]!;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]!;
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq > 0) {
        flags[tok.slice(2, eq)] = tok.slice(eq + 1);
      } else {
        // Look ahead for a non-flag value
        const next = tokens[i + 1];
        if (next && !next.startsWith("--")) {
          flags[tok.slice(2)] = next;
          i++;
        } else {
          flags[tok.slice(2)] = true;
        }
      }
    } else {
      positional.push(tok);
    }
  }
  return { name, positional, flags };
}

function tokenize(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  let quote: string | null = null;
  while (i < s.length) {
    const ch = s[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else if (ch === "\\" && i + 1 < s.length && (s[i + 1] === quote || s[i + 1] === "\\")) {
        // Only `\"` and `\\` are escapes, so Windows paths survive quoting.
        cur += s[i + 1];
        i += 2;
        continue;
      } else {
        cur += ch;
      }
    } else {
      if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === " " || ch === "\t") {
        if (cur.length > 0) {
          out.push(cur);
          cur = "";
        }
      } else {
        cur += ch;
      }
    }
    i++;
  }
  if (cur.length > 0) out.push(cur);
  return out;
}

export function formatCommand(cmd: ParsedCommand): string {
  const parts: string[] = [cmd.name];
  for (const p of cmd.positional) parts.push(quoteIfNeeded(p));
  for (const [k, v] of Object.entries(cmd.flags)) {
    if (v === true) parts.push(`--${k}`);
    else if (typeof v === "string") parts.push(`--${k}=${quoteIfNeeded(v)}`);
  }
  return parts.join(" ");
}

function quoteIfNeeded(s: string): string {
  if (/[\s"'\\]/.test(s)) return `"${s.replace(/"/g, '\\"')}"`;
  return s;
}
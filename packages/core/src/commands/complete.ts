/**
 * Single source of truth for command-name, flag, and identifier completion.
 * Used by both TUI prompt and (in principle) shell completion scripts.
 */

import type { EventKind, FileKey } from "../model/types.ts";

export type CompletionKind = "command" | "flag" | "path" | "fileKey" | "eventKey" | "processName";

export interface Completion {
  text: string;
  displayText: string;
  description?: string;
  kind: CompletionKind;
}

export interface CompleteContext {
  cwd: string;
  knownDirectories: string[];
  knownFileKeys: FileKey[];
  knownProcessNames: string[];
  identityKinds: ("exact" | "path")[];
}

export const KNOWN_COMMANDS: { name: string; description: string; flags?: string[] }[] = [
  { name: "ls", description: "list file timelines under cwd" },
  { name: "cd", description: "change cwd within observed directories" },
  { name: "pwd", description: "print cwd" },
  { name: "open", description: "open a .haril package" },
  { name: "close", description: "close current package" },
  { name: "events", description: "page events of selected file", flags: ["op", "failed", "pid", "process", "reset"] },
  { name: "evidence", description: "show decoded source event" },
  { name: "summary", description: "show file activity summary" },
  { name: "search", description: "search paths and process names" },
  { name: "overview", description: "session-wide totals" },
  { name: "dirs", description: "list observed directories" },
  { name: "size-changes", description: "show observed size deltas" },
  { name: "capture", description: "show capture manifest in activity panel" },
  { name: "heuristics", description: "toggle heuristic view" },
  { name: "zoom", description: "zoom in/out/reset" },
  { name: "start-capture", description: "begin live capture (phase Empty only)", flags: ["root", "output", "seconds"] },
  { name: "stop-capture", description: "stop capture and write package" },
  { name: "force-quit-capture", description: "abort capture without writing" },
  { name: "queue", description: "list pending commands" },
  { name: "cancel", description: "cancel active command" },
  { name: "help", description: "show help" },
  { name: "quit", description: "exit TUI" },
  { name: "exit", description: "exit TUI" },
];

export const FLAG_VALUES: Record<string, string[]> = {
  op: ["Create", "Open", "Read", "Write", "SetInfo", "Rename", "Delete", "Close", "OpEnd", "Notify"],
  identity: ["exact", "path-scoped"],
  root: [], // filled by completion
  output: [],
  seconds: [],
  pid: [],
  process: [],
  failed: [],
  reset: [],
};

export function complete(line: string, cursor: number, ctx: CompleteContext): Completion[] {
  const before = line.slice(0, cursor);
  const tokens = before.split(/\s+/);
  const lastToken = tokens[tokens.length - 1] ?? "";
  const prevToken = tokens[tokens.length - 2] ?? "";
  const startsAt = before.length - lastToken.length;

  if (tokens.length === 1 && !before.endsWith(" ")) {
    return matchCommand(lastToken).map((c) => ({ ...c, kind: "command" as const }));
  }

  if (lastToken.startsWith("--")) {
    const cmdName = tokens[0] ?? "";
    return matchFlag(lastToken.slice(2), cmdName).map((c) => ({ ...c, kind: "flag" as const }));
  }

  if (prevToken.startsWith("--op")) {
    return matchFlagValue(lastToken, FLAG_VALUES.op ?? []).map((c) => ({ ...c, kind: "flag" as const }));
  }

  if (prevToken.startsWith("--identity")) {
    return matchFlagValue(lastToken, FLAG_VALUES.identity ?? []).map((c) => ({ ...c, kind: "flag" as const }));
  }

  if (prevToken.startsWith("--root") || prevToken.startsWith("--output")) {
    return matchFlagValue(lastToken, ctx.knownDirectories).map((c) => ({ ...c, kind: "path" as const }));
  }

  if (prevToken.startsWith("--pid") || prevToken === "--pid") {
    return matchFlagValue(lastToken, []).map((c) => ({ ...c, kind: "flag" as const }));
  }

  if (prevToken.startsWith("--process")) {
    return matchFlagValue(lastToken, ctx.knownProcessNames).map((c) => ({ ...c, kind: "processName" as const }));
  }

  // Positional completions
  if (tokens[0] === "open" || tokens[0] === "cd") {
    return matchFlagValue(lastToken, ctx.knownDirectories).map((c) => ({ ...c, kind: "path" as const }));
  }

  if (tokens[0] === "events" || tokens[0] === "summary" || tokens[0] === "evidence") {
    return matchFlagValue(lastToken, ctx.knownFileKeys.map(fileKeyDisplay)).map((c) => ({ ...c, kind: "fileKey" as const }));
  }

  if (tokens[0] === "search") {
    return matchFlagValue(lastToken, ctx.knownProcessNames).map((c) => ({ ...c, kind: "processName" as const }));
  }

  return [];
}

function matchCommand(partial: string): Completion[] {
  const out: Completion[] = [];
  for (const c of KNOWN_COMMANDS) {
    if (c.name.startsWith(partial)) {
      out.push({ text: c.name, displayText: c.name, description: c.description, kind: "command" });
    }
  }
  return out;
}

function matchFlag(partial: string, cmdName: string): Completion[] {
  const def = KNOWN_COMMANDS.find((c) => c.name === cmdName);
  const flags = def?.flags ?? [];
  const out: Completion[] = [];
  for (const f of flags) {
    if (f.startsWith(partial)) {
      out.push({ text: `--${f}`, displayText: `--${f}`, description: "", kind: "flag" });
    }
  }
  return out;
}

function matchFlagValue(partial: string, candidates: string[]): Completion[] {
  const out: Completion[] = [];
  for (const c of candidates) {
    if (c.toLowerCase().startsWith(partial.toLowerCase())) {
      out.push({ text: c, displayText: c, description: "", kind: "flag" });
    }
  }
  return out;
}

function fileKeyDisplay(key: FileKey): string {
  if (key.kind === "exact") {
    return `id:${key.volumeSerial.toString(16)}:${Array.from(key.fileId128).slice(0, 4).map((b) => b.toString(16).padStart(2, "0")).join("")}…`;
  }
  return `path:${key.path}`;
}
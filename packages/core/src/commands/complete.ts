/**
 * Single source of truth for command-name, flag, and identifier completion.
 * Used by both TUI prompt and (in principle) shell completion scripts.
 */

import { readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { EventKind, FileKey, Phase } from "../model/types.ts";

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
  knownFilePaths?: string[];
  phase?: Phase;
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
  heuristics: ["on", "off"],
  zoom: ["in", "out", "reset"],
  root: [], // filled by completion
  output: [],
  seconds: [],
  pid: [],
  process: [],
  failed: [],
  reset: [],
};

function pathCandidates(token: string, predicate: (path: string) => boolean, defaultBase = "."): string[] {
  const hasTrailingSep = token.endsWith("/") || token.endsWith("\\");
  const base = !token ? defaultBase : hasTrailingSep ? token : token.includes("/") || token.includes("\\") ? dirname(token) : defaultBase;
  const prefix = token && !hasTrailingSep ? basename(token) : "";
  const directory = resolve(base === "." && (token.startsWith("/") || token.startsWith("\\")) ? "/" : base);
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.name.toLowerCase().startsWith(prefix.toLowerCase()))
      .map((entry) => join(base === "." ? "" : base, entry.name))
      .filter((candidate) => {
        try {
          const resolved = resolve(candidate);
          return statSync(resolved).isDirectory() || predicate(resolved);
        } catch {
          return false;
        }
      })
      .map((candidate) => {
        try {
          return candidate + (statSync(resolve(candidate)).isDirectory() ? "\\" : "");
        } catch {
          return candidate;
        }
      });
  } catch {
    return [];
  }
}

export function complete(line: string, cursor: number, ctx: CompleteContext): Completion[] {
  const before = line.slice(0, cursor);
  const tokens = before.split(/\s+/);
  const lastToken = tokens[tokens.length - 1] ?? "";
  const prevToken = tokens[tokens.length - 2] ?? "";

  if (tokens.length === 1 && !before.endsWith(" ")) {
    return matchCommand(lastToken, ctx.phase).map((c) => ({ ...c, kind: "command" as const }));
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

  if (prevToken === "--output") {
    const fsFiles = pathCandidates(lastToken, (p) => extname(p).toLowerCase() === ".haril");
    return fsFiles.map((c) => ({ text: c, displayText: c, kind: "path" as const }));
  }

  if (prevToken === "--root") {
    const fsDirs = pathCandidates(lastToken, (p) => statSync(p).isDirectory());
    return fsDirs.map((c) => ({ text: c, displayText: c, kind: "path" as const }));
  }

  if (prevToken.startsWith("--pid") || prevToken === "--pid") {
    return matchFlagValue(lastToken, []).map((c) => ({ ...c, kind: "flag" as const }));
  }

  if (prevToken.startsWith("--process")) {
    return matchFlagValue(lastToken, ctx.knownProcessNames).map((c) => ({ ...c, kind: "processName" as const }));
  }

  // Positional completions
  if (tokens[0] === "open") {
    const fsMatches = pathCandidates(lastToken, (p) => extname(p).toLowerCase() === ".haril");
    const dirMatches = matchFlagValue(lastToken, ctx.knownDirectories);
    const combined = [...new Set([...fsMatches, ...dirMatches.map((d) => d.text)])];
    return combined.map((c) => ({ text: c, displayText: c, kind: "path" as const }));
  }

  if (tokens[0] === "ls" && ctx.phase !== "analyze") {
    const fsDirs = pathCandidates(lastToken, (p) => statSync(p).isDirectory());
    return fsDirs.map((c) => ({ text: c, displayText: c, kind: "path" as const }));
  }

  if (tokens[0] === "cd") {
    const fsDirs = pathCandidates(lastToken, (p) => statSync(p).isDirectory());
    const knownDirs = matchFlagValue(lastToken, ctx.knownDirectories).map((d) => d.text);
    const combined = [...new Set([...knownDirs, ...fsDirs])];
    return combined.map((c) => ({ text: c, displayText: c, kind: "path" as const }));
  }

  if (tokens[0] === "heuristics") {
    return matchFlagValue(lastToken, ["on", "off"]).map((c) => ({ ...c, kind: "flag" as const }));
  }

  if (tokens[0] === "zoom") {
    return matchFlagValue(lastToken, ["in", "out", "reset"]).map((c) => ({ ...c, kind: "flag" as const }));
  }

  if (tokens[0] === "events" || tokens[0] === "summary" || tokens[0] === "evidence") {
    const filePaths = (ctx.knownFilePaths ?? [])
      .filter((p) => p.toLowerCase().includes(lastToken.toLowerCase()))
      .map((p) => ({ text: p, displayText: p, kind: "path" as const }));
    const fileKeys = matchFlagValue(lastToken, ctx.knownFileKeys.map(fileKeyDisplay)).map((c) => ({ ...c, kind: "fileKey" as const }));
    return [...filePaths, ...fileKeys];
  }

  if (tokens[0] === "search") {
    return matchFlagValue(lastToken, ctx.knownProcessNames).map((c) => ({ ...c, kind: "processName" as const }));
  }

  return [];
}

function matchCommand(partial: string, phase?: Phase): Completion[] {
  let commands = KNOWN_COMMANDS;
  if (phase === "empty") {
    commands = KNOWN_COMMANDS.filter((c) => ["ls", "cd", "pwd", "open", "start-capture", "help", "quit", "exit"].includes(c.name));
  } else if (phase === "live-capture") {
    commands = KNOWN_COMMANDS.filter((c) => ["ls", "cd", "pwd", "stop-capture", "force-quit-capture", "help", "quit", "exit"].includes(c.name));
  }
  const out: Completion[] = [];
  for (const c of commands) {
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

export interface VisibleSuggestionsWindow {
  items: { text: string; originalIndex: number; isSelected: boolean }[];
  hasPrevious: boolean;
  hasNext: boolean;
  startIndex: number;
  endIndex: number;
}

/**
 * Calculates a sliding window of suggestions that fit within maxWidth (in characters).
 * Adapted from fasaled/sailkari.
 */
export function getVisibleSuggestionsWindow(
  suggestions: string[],
  selectedIndex: number,
  maxWidth: number,
  gap = 2
): VisibleSuggestionsWindow {
  if (suggestions.length === 0 || maxWidth <= 0) {
    return { items: [], hasPrevious: false, hasNext: false, startIndex: 0, endIndex: 0 };
  }

  const clampedSelected = Math.max(0, Math.min(selectedIndex, suggestions.length - 1));

  const totalLength = suggestions.reduce((sum, s, idx) => sum + s.length + (idx > 0 ? gap : 0), 0);
  if (totalLength <= maxWidth) {
    return {
      items: suggestions.map((text, idx) => ({
        text,
        originalIndex: idx,
        isSelected: idx === clampedSelected,
      })),
      hasPrevious: false,
      hasNext: false,
      startIndex: 0,
      endIndex: suggestions.length - 1,
    };
  }

  const measureRange = (start: number, end: number): number => {
    let width = 0;
    if (start > 0) width += 4; // "... "
    for (let i = start; i <= end; i++) {
      width += suggestions[i]!.length;
      if (i < end) width += gap;
    }
    if (end < suggestions.length - 1) width += 4; // " ..."
    return width;
  };

  let initEnd = 0;
  while (initEnd + 1 < suggestions.length && measureRange(0, initEnd + 1) <= maxWidth) {
    initEnd++;
  }

  const initialVisibleCount = Math.max(1, initEnd + 1);
  const midpoint = Math.floor(initialVisibleCount / 2);

  let startIndex = 0;
  if (clampedSelected <= midpoint) {
    startIndex = 0;
  } else {
    startIndex = clampedSelected - midpoint;
  }

  startIndex = Math.max(0, Math.min(startIndex, clampedSelected));

  let endIndex = clampedSelected;
  while (endIndex + 1 < suggestions.length && measureRange(startIndex, endIndex + 1) <= maxWidth) {
    endIndex++;
  }

  while (startIndex > 0 && measureRange(startIndex - 1, endIndex) <= maxWidth) {
    startIndex--;
  }

  while (startIndex < clampedSelected && measureRange(startIndex, endIndex) > maxWidth) {
    startIndex++;
  }
  while (endIndex > clampedSelected && measureRange(startIndex, endIndex) > maxWidth) {
    endIndex--;
  }

  const hasPrev = startIndex > 0;
  const hasNext = endIndex < suggestions.length - 1;

  const items = [];
  for (let i = startIndex; i <= endIndex; i++) {
    items.push({
      text: suggestions[i]!,
      originalIndex: i,
      isSelected: i === clampedSelected,
    });
  }

  return {
    items,
    hasPrevious: hasPrev,
    hasNext,
    startIndex,
    endIndex,
  };
}

export function applyCompletion(input: string, completionText: string): string {
  const match = input.match(/(?:^|\s)([^\s]*)$/);
  if (!match) return completionText + " ";
  const token = match[1]!;
  const before = input.slice(0, input.length - token.length);
  const suffix = (completionText.endsWith("/") || completionText.endsWith("\\")) ? "" : " ";
  return before + completionText + suffix;
}
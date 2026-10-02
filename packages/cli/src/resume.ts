/**
 * `haril --resume-pending`: read %LOCALAPPDATA%/Haril/pending-session.json
 * and put the session into the appropriate phase.
 */

import { readFileSync, existsSync, unlinkSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HarilSession, StartCaptureArgs } from "@haril-ts/core";

function pendingPath(): string {
  const appdata = process.env["LOCALAPPDATA"] ?? join(tmpdir(), "Haril");
  return join(appdata, "Haril", "pending-session.json");
}

export function resumePendingSession(session: HarilSession): boolean {
  const path = pendingPath();
  if (!existsSync(path)) return false;
  let data: any;
  try {
    data = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return false;
  }
  if (data.v !== 1) return false;
  session.setCwd(data.cwd ?? "\\");
  session.setHeuristicsEnabled(Boolean(data.heuristicsEnabled));
  if (data.activeEventFilter) session.setActiveFilter(data.activeEventFilter);
  if (data.history && Array.isArray(data.history)) {
    for (const line of data.history) session.pushHistory(String(line));
  }
  if (data.pendingStartCapture) {
    session.setPhase("live-capture");
    return true;
  }
  session.setPhase(data.previousPhase ?? "analyze");
  return true;
}

export interface WritePendingOptions {
  cwd: string;
  previousPhase: "empty" | "live-capture" | "analyze";
  selectedFileKey: unknown;
  selectedEventKey: string | null;
  heuristicsEnabled: boolean;
  activeEventFilter: unknown;
  history: string[];
  pendingStartCapture?: StartCaptureArgs;
}

export function writePendingSession(opts: WritePendingOptions): void {
  const path = pendingPath();
  const dir = path.substring(0, path.lastIndexOf("\\"));
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // best-effort
  }
  const payload = JSON.stringify({
    v: 1,
    previousPhase: opts.previousPhase,
    cwd: opts.cwd,
    selectedFileKey: opts.selectedFileKey,
    selectedEventKey: opts.selectedEventKey,
    heuristicsEnabled: opts.heuristicsEnabled,
    activeEventFilter: opts.activeEventFilter,
    history: opts.history.slice(-200),
    pendingStartCapture: opts.pendingStartCapture,
  }, null, 2);
  try {
    writeFileSync(path, payload);
  } catch {
    // best-effort
  }
}

export function clearPendingSession(): void {
  const path = pendingPath();
  if (existsSync(path)) {
    try { unlinkSync(path); } catch {
      // best-effort
    }
  }
}
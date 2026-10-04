/**
 * `HarilSession` — the orchestrator. Owns a `SqliteStore`, the
 * `FileTimelineCommands`, the active `Phase`, and the package `Manifest`
 * once a `.haril` is loaded.
 *
 * `run(line)` parses the line, dispatches to a handler, and returns a
 * `CommandResult`. `snapshot()` exposes the current state to the TUI.
 *
 * The same session can be in one of three phases (Empty / Live-capture /
 * Analyze) and the same command core services them; phase transitions
 * happen by opening a package or by starting capture.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SqliteStore } from "./store/sqlite.ts";
import { importPackageIntoStore } from "./store/import.ts";
import { FileTimelineCommands } from "./commands/file_timeline.ts";
import { parseCommand, type ParsedCommand } from "./commands/parse.ts";
import { runCapture } from "./capture/capture.ts";
import { fileKeyHash } from "./model/fileKey.ts";
import type { CommandResult, EventFilter, FileKey, Phase } from "./model/types.ts";

export interface StartCaptureArgs {
  root: string;
  output: string;
  seconds: number;
}

export interface SessionSnapshot {
  phase: Phase;
  packagePath?: string;
  packageManifest?: import("./model/types.ts").Manifest;
  cwd: string;
  selectedFileKey: FileKey | null;
  selectedEventKey: string | null;
  zoomRange: { from_ns: bigint; to_ns: bigint } | null;
  heuristicsEnabled: boolean;
  activeEventFilter: EventFilter | null;
  historyLength: number;
  queueLength: number;
  sourceStatus: { etw: boolean; usn: boolean; fsw: boolean };
}

export interface RunOptions {
  captureArgs?: StartCaptureArgs;
  captureInProgress?: boolean;
  outputPackagePath?: string;
}

export class HarilSession {
  private store: SqliteStore;
  private commands: FileTimelineCommands;
  private _phase: Phase = "empty";
  private _packagePath?: string;
  private _packageManifest?: import("./model/types.ts").Manifest;
  private _cwd = "\\";
  private _selectedFileKey: FileKey | null = null;
  private _selectedEventKey: string | null = null;
  private _zoomRange: { from_ns: bigint; to_ns: bigint } | null = null;
  private _heuristicsEnabled = false;
  private _activeFilter: EventFilter | null = null;
  private _history: string[] = [];
  private _queue: { line: string }[] = [];

  constructor(opts: { phase?: Phase; tempDir?: string } = {}) {
    const dir = opts.tempDir ?? mkdtempSync(join(tmpdir(), "haril-"));
    this.store = new SqliteStore({ path: join(dir, "index.sqlite") });
    this.commands = new FileTimelineCommands(this.store);
    if (opts.phase) this._phase = opts.phase;
  }

  close(): void {
    this.store.close();
  }

  snapshot(): SessionSnapshot {
    const manifest = this._phase === "analyze" ? this._packageManifest : undefined;
    return {
      phase: this._phase,
      packagePath: this._packagePath,
      packageManifest: this._packageManifest,
      cwd: this._cwd,
      selectedFileKey: this._selectedFileKey,
      selectedEventKey: this._selectedEventKey,
      zoomRange: this._zoomRange,
      heuristicsEnabled: this._heuristicsEnabled,
      activeEventFilter: this._activeFilter,
      historyLength: this._history.length,
      queueLength: this._queue.length,
      sourceStatus: {
        etw: manifest?.sources.etw.available ?? false,
        usn: manifest?.sources.usn.available ?? false,
        fsw: manifest?.sources.fsw.available ?? false,
      },
    };
  }

  /** Set the underlying store directly (used when injecting an analyzed index). */
  setStore(store: SqliteStore): void {
    this.store = store;
    this.commands = new FileTimelineCommands(store);
  }

  setPackage(opts: { path: string; manifest: import("./model/types.ts").Manifest }): void {
    this._packagePath = opts.path;
    this._packageManifest = opts.manifest;
    this._phase = "analyze";
  }

  setPhase(phase: Phase): void {
    this._phase = phase;
  }

  setCwd(cwd: string): void {
    this._cwd = cwd;
  }

  setSelectedFileKey(key: FileKey | null): void {
    this._selectedFileKey = key;
  }

  setSelectedEventKey(id: string | null): void {
    this._selectedEventKey = id;
  }

  setZoomRange(range: { from_ns: bigint; to_ns: bigint } | null): void {
    this._zoomRange = range;
  }

  setHeuristicsEnabled(v: boolean): void {
    this._heuristicsEnabled = v;
  }

  setActiveFilter(f: EventFilter | null): void {
    this._activeFilter = f;
  }

  pushHistory(line: string): void {
    if (line.trim().length === 0) return;
    if (this._history[this._history.length - 1] === line) return;
    this._history.push(line);
    if (this._history.length > 200) this._history.shift();
  }

  history(): readonly string[] {
    return this._history;
  }

  async run(line: string): Promise<CommandResult> {
    this.pushHistory(line);
    const cmd = parseCommand(line);
    return this.runCommand(cmd);
  }

  async runCommand(cmd: ParsedCommand): Promise<CommandResult> {
    if (this._phase === "empty") return this.dispatchEmpty(cmd);
    if (this._phase === "live-capture") return this.dispatchLiveCapture(cmd);
    return this.dispatchAnalyze(cmd);
  }

  // -- Phase dispatch --

  private async dispatchEmpty(cmd: ParsedCommand): Promise<CommandResult> {
    if (cmd.name === "open") {
      const path = cmd.positional[0];
      if (!path) return { ok: false, kind: "error", error: "open requires a path" };
      return { ok: true, kind: "none", data: { action: "open-analyze", path } };
    }
    if (cmd.name === "start-capture") {
      const root = cmd.flags["root"];
      const output = cmd.flags["output"];
      const seconds = cmd.flags["seconds"];
      if (!root || typeof root !== "string") {
        return { ok: false, kind: "error", error: "start-capture requires --root <dir>" };
      }
      if (!output || typeof output !== "string") {
        return { ok: false, kind: "error", error: "start-capture requires --output <file.haril>" };
      }
      const secs = seconds === undefined ? 30 : parseInt(String(seconds), 10);
      if (!Number.isFinite(secs) || secs < 1 || secs > 300) {
        return { ok: false, kind: "error", error: "start-capture --seconds must be 1..300" };
      }
      try {
        const result = await runCapture({ root, output, seconds: secs });
        const dir = mkdtempSync(join(tmpdir(), "haril-"));
        const store = new SqliteStore({ path: join(dir, "index.sqlite") });
        await importPackageIntoStore(output, store);
        this.setStore(store);
        this.setPackage({ path: output, manifest: result.manifest });
        const s = result.manifest.sources;
        const lines = [
          `capture complete: ${output}`,
          `events=${result.events.length} notifications=${result.notifications.length}`,
          `etw=${s.etw.available ? `on (observed=${s.etw.eventsObserved} lost=${s.etw.eventsLost})` : `off (rc=${s.etw.startRc ?? "n/a"})`}`,
          `usn=${s.usn.available ? `on (records=${s.usn.recordsRead})` : `off (rc=${s.usn.startRc ?? "n/a"})`}`,
          `fsw=on (notifications=${s.fsw.notifications})`,
        ];
        if (!s.etw.available || !s.usn.available) {
          if (!result.nativeAvailable) {
            lines.push("note: native addon unavailable; kernel sources (ETW/USN) need haril_native.node.");
          } else {
            lines.push("note: kernel sources need an elevated terminal; rerun elevated for full capture.");
          }
        }
        return { ok: true, kind: "text", data: lines.join("\n") };
      } catch (err) {
        return {
          ok: false,
          kind: "error",
          error: `start-capture failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }
    if (cmd.name === "help") return this.helpResult();
    if (cmd.name === "quit" || cmd.name === "exit") return { ok: true, kind: "none", data: { action: "quit" } };
    return { ok: false, kind: "error", error: `unknown command in Empty phase: ${cmd.name}` };
  }

  private dispatchLiveCapture(cmd: ParsedCommand): CommandResult {
    if (cmd.name === "stop-capture") {
      return { ok: true, kind: "none", data: { action: "stop-capture", packagePath: "" } };
    }
    if (cmd.name === "force-quit-capture") {
      return { ok: true, kind: "none", data: { action: "force-quit" } };
    }
    return this.dispatchAnalyze(cmd);
  }

  private dispatchAnalyze(cmd: ParsedCommand): CommandResult {
    switch (cmd.name) {
      case "ls":
        return this.commands.browseFileTimelines({
          directory: cmd.positional[0] ?? this._cwd,
          offset: cmd.flags["offset"] != null ? parseInt(String(cmd.flags["offset"]), 10) : undefined,
          limit: cmd.flags["limit"] != null ? parseInt(String(cmd.flags["limit"]), 10) : undefined,
          pathPattern: typeof cmd.flags["pattern"] === "string" ? cmd.flags["pattern"] : undefined,
          identityKind: this.parseIdentityKind(cmd.flags["identity"]),
        });
      case "cd": {
        const target = cmd.positional[0];
        if (!target) return { ok: false, kind: "error", error: "cd requires a directory" };
        this._cwd = join(this._cwd, target).replace(/\//g, "\\");
        return { ok: true, kind: "none" };
      }
      case "pwd":
        return { ok: true, kind: "json", data: { cwd: this._cwd } };
      case "close":
        this._phase = "empty";
        this._packagePath = undefined;
        this._packageManifest = undefined;
        return { ok: true, kind: "none", data: { action: "close" } };
      case "events": {
        const target = this.resolveTarget(cmd.positional[0]);
        const filter: EventFilter = {};
        if (typeof cmd.flags["op"] === "string") filter.opKinds = [cmd.flags["op"] as any];
        if (cmd.flags["failed"] === true) filter.failedOnly = true;
        if (typeof cmd.flags["pid"] === "string") filter.pid = parseInt(cmd.flags["pid"], 10);
        if (typeof cmd.flags["process"] === "string") filter.processName = cmd.flags["process"];
        if (cmd.flags["reset"] === true) {
          this._activeFilter = null;
          return { ok: true, kind: "none", data: { reset: true } };
        }
        if (Object.keys(filter).length > 0) this._activeFilter = filter;
        if (!target) return { ok: false, kind: "error", error: "events requires a fileKey or path; select a file first" };
        const offset = cmd.flags["offset"] != null ? parseInt(String(cmd.flags["offset"]), 10) : undefined;
        const limit = cmd.flags["limit"] != null ? parseInt(String(cmd.flags["limit"]), 10) : undefined;
        return this.commands.inspectFileTimeline({ fileKeyHash: target, offset, limit, filter: this._activeFilter ?? undefined });
      }
      case "evidence": {
        let hash: string | null = null;
        let eventId: number;

        if (cmd.positional.length >= 2) {
          hash = this.resolveTarget(cmd.positional[0]);
          eventId = parseInt(cmd.positional[1] ?? "", 10);
        } else {
          eventId = parseInt(cmd.positional[0] ?? "", 10);
          hash = typeof cmd.flags["file"] === "string" ? this.resolveTarget(cmd.flags["file"]) : this.resolveTarget();
        }

        if (!Number.isFinite(eventId)) {
          return { ok: false, kind: "error", error: "evidence requires an event id" };
        }
        if (!hash) {
          const row = this.store.getEventById(eventId);
          if (!row) return { ok: false, kind: "error", error: `event id ${eventId} not found` };
          return { ok: true, kind: "json", data: row };
        }
        return this.commands.inspectFileTimelineEvent({ fileKeyHash: hash, eventIndex: eventId });
      }
      case "summary": {
        const target = this.resolveTarget(cmd.positional[0]);
        if (!target) return { ok: false, kind: "error", error: "summary requires a fileKey or path" };
        return this.commands.getFileActivitySummary({ fileKeyHash: target });
      }
      case "search": {
        const text = cmd.positional[0];
        if (!text) return { ok: false, kind: "error", error: "search requires a text argument" };
        const offset = cmd.flags["offset"] != null ? parseInt(String(cmd.flags["offset"]), 10) : undefined;
        const limit = cmd.flags["limit"] != null ? parseInt(String(cmd.flags["limit"]), 10) : undefined;
        return this.commands.searchFileTimelines({ text, offset, limit });
      }
      case "overview":
        return this.commands.getSessionActivityOverview();
      case "dirs": {
        const offset = cmd.flags["offset"] != null ? parseInt(String(cmd.flags["offset"]), 10) : undefined;
        const limit = cmd.flags["limit"] != null ? parseInt(String(cmd.flags["limit"]), 10) : undefined;
        return this.commands.listObservedDirectories({ offset, limit });
      }
      case "size-changes":
        return this.commands.getFileSizeChanges({});
      case "capture":
        return { ok: true, kind: "json", data: this._packageManifest ?? null };
      case "heuristics": {
        const arg = cmd.positional[0];
        if (arg === "on") this._heuristicsEnabled = true;
        else if (arg === "off") this._heuristicsEnabled = false;
        else this._heuristicsEnabled = !this._heuristicsEnabled;
        return { ok: true, kind: "json", data: { heuristicsEnabled: this._heuristicsEnabled } };
      }
      case "zoom": {
        const arg = cmd.positional[0];
        if (arg === "reset" || !arg) this._zoomRange = null;
        return { ok: true, kind: "json", data: { zoomRange: this._zoomRange } };
      }
      case "queue":
        return { ok: true, kind: "json", data: { items: this._queue } };
      case "cancel":
        return { ok: true, kind: "none", data: { cancelled: true } };
      case "help":
        return this.helpResult();
      case "quit":
      case "exit":
        return { ok: true, kind: "none", data: { action: "quit" } };
      default:
        return { ok: false, kind: "error", error: `unknown command: ${cmd.name}` };
    }
  }

  private resolveTarget(arg?: string): string | null {
    if (arg) {
      if (!arg.startsWith("exact:") && !arg.startsWith("path:")) {
        const found = this.store.getFileByPath(arg);
        if (found) return found.fileKeyHash;
      }
      return arg;
    }
    if (this._selectedFileKey) return fileKeyHash(this._selectedFileKey);
    return null;
  }

  private parseIdentityKind(v: unknown): "exact" | "path" | undefined {
    if (typeof v !== "string") return undefined;
    if (v === "exact") return "exact";
    if (v === "path-scoped" || v === "path") return "path";
    return undefined;
  }

  private helpResult(): CommandResult {
    return {
      ok: true,
      kind: "text",
      data: [
        "ls [path] [--pattern <glob>] [--identity exact|path-scoped]",
        "cd <dir>",
        "pwd",
        "open <path.haril>           (Empty phase)",
        "close                       (Analyze phase)",
        "events [<fileKey>] [--op <k>] [--failed] [--pid <n>] [--process <name>] [reset]",
        "evidence [<eventKey>]",
        "summary [<fileKey>]",
        "search <text>",
        "overview",
        "dirs",
        "size-changes",
        "capture",
        "heuristics [on|off]",
        "zoom [in|out|reset]",
        "start-capture [--root <dir>] [--output <file.haril>] [--seconds <n>]   (Empty phase)",
        "stop-capture                (Live Capture phase)",
        "force-quit-capture          (Live Capture phase)",
        "queue",
        "cancel",
        "help",
        "quit / exit",
      ].join("\n"),
    };
  }
}

export async function createSession(opts: { phase?: Phase; tempDir?: string } = {}): Promise<HarilSession> {
  return new HarilSession(opts);
}

export function bindSession(opts: { phase?: Phase; tempDir?: string } = {}): HarilSession {
  return new HarilSession(opts);
}
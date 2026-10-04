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

import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve, win32 } from "node:path";

import { SqliteStore } from "./store/sqlite.ts";
import { importPackageIntoStore } from "./store/import.ts";
import { readPackage } from "./package/reader.ts";
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

export interface SessionEvent {
  type: "capture-started" | "capture-complete" | "capture-error" | "state-changed";
  message?: string;
  ok?: boolean;
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

export interface LiveFile {
  /** Root-relative path, e.g. `\sub\a.txt`. */
  path: string;
  eventCount: number;
  lastKind: string;
  deleted: boolean;
}

export interface LiveEvent {
  seq: number;
  /** Nanoseconds since capture start (same clock as the package). */
  offsetNs: bigint;
  kind: string;
  source: "etw" | "usn" | "fsw";
  path: string | null;
  pid: number | null;
  process: string | null;
}

export interface LiveCaptureState {
  /** Monotonic counter bumped on every change, so the UI can skip re-renders. */
  version: number;
  root: string;
  output: string;
  seconds: number;
  startedAt: number;
  sources: { native: boolean; etw: boolean; usn: boolean; etwRc: number; usnRc: number } | null;
  counts: { etw: number; usn: number; fsw: number };
  totalEvents: number;
  files: LiveFile[];
  /** Most recent events (bounded tail). */
  events: LiveEvent[];
}

export const LIVE_EVENT_TAIL = 2000;

export interface RunOptions {
  captureArgs?: StartCaptureArgs;
  captureInProgress?: boolean;
  outputPackagePath?: string;
}

/** Default capture package name when --output is omitted: haril-YYYYMMDD-HHMMSS.haril (local time). */
export function defaultCaptureFileName(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  const time = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `haril-${date}-${time}.haril`;
}

/** Case-insensitive `*` / `?` glob over a single name (used by filesystem `ls --pattern`). */
function globToRegExp(glob: string): RegExp {
  const src = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${src}$`, "i");
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
  private _activeCapture: {
    root: string;
    output: string;
    seconds: number;
    startedAt: number;
    ac: AbortController;
    promise: Promise<void>;
  } | null = null;
  private _listeners: ((ev: SessionEvent) => void)[] = [];
  private _live: {
    version: number;
    root: string;
    output: string;
    seconds: number;
    startedAt: number;
    startNs: bigint | null;
    sources: LiveCaptureState["sources"];
    counts: { etw: number; usn: number; fsw: number };
    totalEvents: number;
    files: Map<string, LiveFile>;
    events: LiveEvent[];
  } | null = null;
  private _liveCache: LiveCaptureState | null = null;

  constructor(opts: { phase?: Phase; tempDir?: string } = {}) {
    const dir = opts.tempDir ?? mkdtempSync(join(tmpdir(), "haril-"));
    this.store = new SqliteStore({ path: join(dir, "index.sqlite") });
    this.commands = new FileTimelineCommands(this.store);
    if (opts.phase) this._phase = opts.phase;
  }

  close(): void {
    if (this._activeCapture) {
      this._activeCapture.ac.abort();
      this._activeCapture = null;
    }
    this.store.close();
  }

  onEvent(listener: (ev: SessionEvent) => void): () => void {
    this._listeners.push(listener);
    return () => {
      this._listeners = this._listeners.filter((l) => l !== listener);
    };
  }

  emitEvent(ev: SessionEvent): void {
    for (const l of this._listeners) {
      try {
        l(ev);
      } catch {}
    }
  }

  get isCapturing(): boolean {
    return this._activeCapture !== null;
  }

  get activeCaptureInfo(): { root: string; output: string; seconds: number; startedAt: number } | null {
    if (!this._activeCapture) return null;
    return {
      root: this._activeCapture.root,
      output: this._activeCapture.output,
      seconds: this._activeCapture.seconds,
      startedAt: this._activeCapture.startedAt,
    };
  }

  async waitForActiveCapture(): Promise<void> {
    if (this._activeCapture) {
      await this._activeCapture.promise;
    }
  }

  /** Live view of the running (or last) capture; null when none started. */
  liveState(): LiveCaptureState | null {
    const l = this._live;
    if (!l) return null;
    if (this._liveCache && this._liveCache.version === l.version) return this._liveCache;
    this._liveCache = {
      version: l.version,
      root: l.root,
      output: l.output,
      seconds: l.seconds,
      startedAt: l.startedAt,
      sources: l.sources,
      counts: { ...l.counts },
      totalEvents: l.totalEvents,
      files: [...l.files.values()].map((f) => ({ ...f })),
      events: l.events.slice(),
    };
    return this._liveCache;
  }

  private beginLive(root: string, output: string, seconds: number): void {
    this._live = {
      version: 1,
      root,
      output,
      seconds,
      startedAt: Date.now(),
      startNs: null,
      sources: null,
      counts: { etw: 0, usn: 0, fsw: 0 },
      totalEvents: 0,
      files: new Map(),
      events: [],
    };
    this._liveCache = null;
  }

  private liveRelPath(p: string | null | undefined): string | null {
    if (!p || !this._live) return null;
    const root = this._live.root.replace(/[\\/]+$/, "");
    const norm = p.replace(/\//g, "\\");
    if (norm.toLowerCase().startsWith(root.toLowerCase() + "\\")) return norm.slice(root.length);
    return norm.startsWith("\\") ? norm : "\\" + norm;
  }

  private liveTouchFile(path: string, kind: string, countEvent: boolean): void {
    const l = this._live!;
    let f = l.files.get(path.toLowerCase());
    if (!f) {
      f = { path, eventCount: 0, lastKind: kind, deleted: false };
      l.files.set(path.toLowerCase(), f);
    }
    if (countEvent) f.eventCount++;
    f.lastKind = kind;
    f.deleted = kind === "Delete" || kind === "delete";
  }

  private livePushEvent(e: Omit<LiveEvent, "seq" | "offsetNs">, ts: bigint): void {
    const l = this._live!;
    if (l.startNs === null) l.startNs = ts;
    const offsetNs = ts >= l.startNs ? ts - l.startNs : 0n;
    l.totalEvents++;
    l.counts[e.source]++;
    l.events.push({ ...e, seq: l.totalEvents, offsetNs });
    if (l.events.length > LIVE_EVENT_TAIL) l.events.splice(0, l.events.length - LIVE_EVENT_TAIL);
    if (e.path) this.liveTouchFile(e.path, e.kind, true);
    l.version++;
  }

  private liveHooks(): import("./capture/capture.ts").CaptureLiveHooks {
    return {
      onSources: (info) => {
        if (!this._live) return;
        this._live.sources = info;
        this._live.version++;
      },
      onInventory: (entries) => {
        if (!this._live) return;
        if (entries.length > 0 && this._live.startNs === null) this._live.startNs = entries[0]!.observedAt;
        for (const e of entries) {
          const rel = this.liveRelPath(e.path);
          if (!rel || (e.attributes & 0x10) !== 0) continue;
          if (!this._live.files.has(rel.toLowerCase())) this.liveTouchFile(rel, "existing", false);
        }
        this._live.version++;
      },
      onEvent: (ev) => {
        if (!this._live) return;
        this.livePushEvent(
          {
            kind: ev.eventKind,
            source: ev.source,
            path: this.liveRelPath(ev.observedPath),
            pid: ev.pid ?? null,
            process: ev.processImageName,
          },
          BigInt(ev.timestamp_ns),
        );
      },
      onNotification: (n) => {
        if (!this._live) return;
        const path = this.liveRelPath(n.path);
        const old = this.liveRelPath(n.oldPath);
        if (n.kind === "rename" && old) {
          const f = this._live.files.get(old.toLowerCase());
          if (f) f.deleted = true;
        }
        this.livePushEvent(
          { kind: n.kind, source: "fsw", path, pid: n.pid, process: null },
          BigInt(n.timestamp_ns),
        );
      },
    };
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
    this._cwd = "\\";
  }

  setPhase(phase: Phase): void {
    this._phase = phase;
  }

  setCwd(cwd: string): void {
    this._cwd = cwd;
  }

  /** Real filesystem path of the package cwd (capture root + relative cwd). */
  realCwd(): string {
    const root = this._packageManifest?.root;
    if (!root) return process.cwd();
    const rel = this._cwd.replace(/^\\+/, "");
    return rel ? win32.join(root, rel) : root;
  }

  /**
   * Resolves a `cd`/`ls` argument to a root-relative directory (`\`, `\sub`).
   * Accepts relative paths (`sub`, `..`), root-relative ones (`\sub`) and
   * absolute paths inside the capture root. Returns null when outside.
   */
  resolvePackageDir(target: string): string | null {
    let t = target.trim().replace(/\//g, "\\");
    if (/^"(.*)"$/.test(t)) t = t.slice(1, -1);
    const root = this._packageManifest?.root?.replace(/\\+$/, "");
    let base = this._cwd;
    if (/^[A-Za-z]:/.test(t) || t.startsWith("\\\\")) {
      if (!root) return null;
      const abs = win32.normalize(t).replace(/\\+$/, "");
      if (abs.toLowerCase() === root.toLowerCase()) return "\\";
      if (!abs.toLowerCase().startsWith(root.toLowerCase() + "\\")) return null;
      t = abs.slice(root.length);
    }
    if (t.startsWith("\\")) base = "\\";
    const parts = base.split("\\").filter(Boolean);
    for (const seg of t.split("\\")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") parts.pop();
      else parts.push(seg);
    }
    return "\\" + parts.join("\\");
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
    const fsNav = this.dispatchFsNavigation(cmd);
    if (fsNav) return fsNav;
    if (cmd.name === "open") {
      const path = cmd.positional[0];
      if (!path) return { ok: false, kind: "error", error: "open requires a path" };
      try {
        const pkg = await readPackage(path);
        const dir = mkdtempSync(join(tmpdir(), "haril-"));
        const store = new SqliteStore({ path: join(dir, "index.sqlite") });
        await importPackageIntoStore(path, store);
        this.setStore(store);
        this.setPackage({ path, manifest: pkg.manifest });
        return { ok: true, kind: "none", data: { action: "open-analyze", path } };
      } catch (err) {
        return { ok: false, kind: "error", error: `open failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    if (cmd.name === "start-capture") {
      if (this._activeCapture) {
        return { ok: false, kind: "error", error: "capture already in progress: only one capture can run at a time" };
      }
      const rawRoot = cmd.flags["root"];
      const rawOutput = cmd.flags["output"];
      const seconds = cmd.flags["seconds"];
      if (rawRoot !== undefined && (typeof rawRoot !== "string" || rawRoot === "")) {
        return { ok: false, kind: "error", error: "start-capture --root requires a directory" };
      }
      if (rawOutput !== undefined && (typeof rawOutput !== "string" || rawOutput === "")) {
        return { ok: false, kind: "error", error: "start-capture --output requires a file path" };
      }
      // Relative paths are resolved against the process working directory.
      const root = resolve(typeof rawRoot === "string" ? rawRoot : ".");
      const output = resolve(typeof rawOutput === "string" ? rawOutput : defaultCaptureFileName());
      let rootIsDir = false;
      try {
        rootIsDir = statSync(root).isDirectory();
      } catch {
        rootIsDir = false;
      }
      if (!rootIsDir) {
        return { ok: false, kind: "error", error: `start-capture: --root is not a directory: ${root}` };
      }
      const secs = seconds === undefined ? 30 : parseInt(String(seconds), 10);
      if (!Number.isFinite(secs) || secs < 1 || secs > 300) {
        return { ok: false, kind: "error", error: "start-capture --seconds must be 1..300" };
      }

      const ac = new AbortController();
      this._phase = "live-capture";
      this._packagePath = output;
      this.beginLive(root, output, secs);
      const live = this.liveHooks();

      const runCaptureFn = async () => {
        try {
          const result = await runCapture({ root, output, seconds: secs, signal: ac.signal, live });
          const dir = mkdtempSync(join(tmpdir(), "haril-"));
          const store = new SqliteStore({ path: join(dir, "index.sqlite") });
          await importPackageIntoStore(output, store);
          this.setStore(store);
          this.setPackage({ path: output, manifest: result.manifest });
          this._phase = "analyze";
          const s = result.manifest.sources;
          const lines = [
            `✓ capture complete: ${output}`,
            `  events=${result.events.length} notifications=${result.notifications.length}`,
            `  etw=${s.etw.available ? `on (observed=${s.etw.eventsObserved} lost=${s.etw.eventsLost})` : `off (rc=${s.etw.startRc ?? "n/a"})`}`,
            `  usn=${s.usn.available ? `on (records=${s.usn.recordsRead})` : `off (rc=${s.usn.startRc ?? "n/a"})`}`,
            `  fsw=on (notifications=${s.fsw.notifications})`,
          ];
          if (!s.etw.available || !s.usn.available) {
            if (!result.nativeAvailable) {
              lines.push("  note: native addon unavailable; kernel sources (ETW/USN) need haril_native.node.");
            } else {
              lines.push("  note: kernel sources need an elevated terminal; rerun elevated for full capture.");
            }
          }
          const text = lines.join("\n");
          this.emitEvent({ type: "capture-complete", message: text, ok: true });
          return text;
        } catch (err) {
          this._phase = "empty";
          const msg = `start-capture failed: ${err instanceof Error ? err.message : String(err)}`;
          this.emitEvent({ type: "capture-error", message: msg, ok: false });
          if (cmd.flags["background"] === true || cmd.flags["bg"] === true) {
            return msg;
          }
          throw err;
        } finally {
          this._activeCapture = null;
        }
      };

      const capturePromise = runCaptureFn();
      this._activeCapture = {
        root,
        output,
        seconds: secs,
        startedAt: Date.now(),
        ac,
        promise: capturePromise.then(() => {}, () => {}),
      };
      this.emitEvent({ type: "capture-started", message: `capture started on ${root}`, ok: true });

      // If caller requested background execution (or TUI):
      if (cmd.flags["background"] === true || cmd.flags["bg"] === true) {
        return {
          ok: true,
          kind: "text",
          data: `Capture started in background: ${root} (${secs}s) -> ${output}\nPhase changed to live-capture. UI remains fully active.\nType 'stop-capture' to finish early or 'force-quit-capture' to cancel.`,
        };
      }

      // Synchronous wait (default for scripts and unit tests):
      try {
        const text = await capturePromise;
        return { ok: true, kind: "text", data: text };
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

  private async dispatchLiveCapture(cmd: ParsedCommand): Promise<CommandResult> {
    const fsNav = this.dispatchFsNavigation(cmd);
    if (fsNav) return fsNav;
    if (cmd.name === "start-capture") {
      return { ok: false, kind: "error", error: "capture already in progress: only one capture can run at a time" };
    }
    if (cmd.name === "stop-capture") {
      if (this._activeCapture) {
        this._activeCapture.ac.abort();
        return { ok: true, kind: "text", data: "stopping capture and finalizing package..." };
      }
      return { ok: false, kind: "error", error: "no active capture in progress" };
    }
    if (cmd.name === "force-quit-capture") {
      if (this._activeCapture) {
        this._activeCapture.ac.abort();
        this._activeCapture = null;
      }
      this._phase = "empty";
      return { ok: true, kind: "text", data: "capture aborted without writing package" };
    }
    return this.dispatchAnalyze(cmd);
  }

  /**
   * `ls`/`cd`/`pwd` outside a package operate on the real filesystem and the
   * process working directory, which is what relative `--root`/`--output`
   * paths resolve against. Returns null for other commands.
   */
  private dispatchFsNavigation(cmd: ParsedCommand): CommandResult | null {
    if (cmd.name === "pwd") return { ok: true, kind: "text", data: process.cwd() };
    if (cmd.name === "cd") {
      const target = cmd.positional[0] ?? homedir();
      const next = resolve(target);
      try {
        if (!statSync(next).isDirectory()) return { ok: false, kind: "error", error: `cd: not a directory: ${target}` };
        process.chdir(next);
      } catch (err) {
        return { ok: false, kind: "error", error: `cd: ${err instanceof Error ? err.message : String(err)}` };
      }
      return { ok: true, kind: "text", data: process.cwd() };
    }
    if (cmd.name === "ls") {
      const dir = resolve(cmd.positional[0] ?? ".");
      const pattern = typeof cmd.flags["pattern"] === "string" ? globToRegExp(cmd.flags["pattern"]) : null;
      try {
        const entries = readdirSync(dir, { withFileTypes: true })
          .filter((e) => !pattern || pattern.test(e.name))
          .map((e) => {
            const isDir = e.isDirectory();
            let size = "";
            if (!isDir) {
              try {
                size = String(statSync(join(dir, e.name)).size);
              } catch {
                size = "?";
              }
            }
            return { name: isDir ? `${e.name}\\` : e.name, isDir, size };
          })
          .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
        if (entries.length === 0) return { ok: true, kind: "text", data: `${dir}\n(empty)` };
        const width = Math.max(...entries.map((e) => e.size.length), 5);
        const lines = entries.map((e) => `${(e.isDir ? "<dir>" : e.size).padStart(width)}  ${e.name}`);
        return { ok: true, kind: "text", data: `${dir}\n${lines.join("\n")}` };
      } catch (err) {
        return { ok: false, kind: "error", error: `ls: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    return null;
  }

  private async dispatchAnalyze(cmd: ParsedCommand): Promise<CommandResult> {
    switch (cmd.name) {
      case "start-capture":
        return {
          ok: false,
          kind: "error",
          error: "cannot start capture while analyzing a package; use 'close' first",
        };
      case "open": {
        const path = cmd.positional[0];
        if (!path) return { ok: false, kind: "error", error: "open requires a path" };
        try {
          const pkg = await readPackage(path);
          const dir = mkdtempSync(join(tmpdir(), "haril-"));
          const store = new SqliteStore({ path: join(dir, "index.sqlite") });
          await importPackageIntoStore(path, store);
          this.setStore(store);
          this.setPackage({ path, manifest: pkg.manifest });
          return { ok: true, kind: "none", data: { action: "open-analyze", path } };
        } catch (err) {
          return { ok: false, kind: "error", error: `open failed: ${err instanceof Error ? err.message : String(err)}` };
        }
      }
      case "ls": {
        const dir = cmd.positional[0] != null ? this.resolvePackageDir(cmd.positional[0]) : this._cwd;
        if (dir === null) return { ok: false, kind: "error", error: `ls: path is outside the capture root: ${cmd.positional[0]}` };
        return this.commands.browseFileTimelines({
          directory: dir,
          offset: cmd.flags["offset"] != null ? parseInt(String(cmd.flags["offset"]), 10) : undefined,
          limit: cmd.flags["limit"] != null ? parseInt(String(cmd.flags["limit"]), 10) : undefined,
          pathPattern: typeof cmd.flags["pattern"] === "string" ? cmd.flags["pattern"] : undefined,
          identityKind: this.parseIdentityKind(cmd.flags["identity"]),
        });
      }
      case "cd": {
        const target = cmd.positional[0] ?? "\\";
        const next = this.resolvePackageDir(target);
        if (next === null) return { ok: false, kind: "error", error: `cd: path is outside the capture root: ${target}` };
        if (next !== "\\") {
          const probe = this.commands.browseFileTimelines({ directory: next, limit: 1 });
          const items = (probe.data as { items?: unknown[] } | undefined)?.items ?? [];
          if (items.length === 0) return { ok: false, kind: "error", error: `cd: no observed files under ${next}` };
        }
        this._cwd = next;
        return { ok: true, kind: "json", data: { action: "cd", cwd: this._cwd, path: this.realCwd() } };
      }
      case "pwd":
        return { ok: true, kind: "json", data: { cwd: this._cwd, path: this.realCwd() } };
      case "close":
        this._phase = "empty";
        this._packagePath = undefined;
        this._packageManifest = undefined;
        this._cwd = "\\";
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
        if (this._activeCapture) {
          this._activeCapture.ac.abort();
          this._activeCapture = null;
          this._phase = "empty";
          return { ok: true, kind: "text", data: "Active capture cancelled." };
        }
        return { ok: true, kind: "text", data: "No active operation to cancel." };
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
        "ls [path] [--pattern <glob>] [--identity exact|path-scoped]   (filesystem outside Analyze)",
        "cd <dir>                    (filesystem outside Analyze)",
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
        "start-capture [--root <dir>] [--output <file.haril>] [--seconds <n>]   (Empty phase; defaults: root = cwd, output = haril-YYYYMMDD-HHMMSS.haril)",
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
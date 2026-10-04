/**
 * FileSystemWatcher wrapper. Uses `node:fs.watch` with `recursive: true`.
 *
 * Emits `PathNotification` rows that the pipeline consumer appends to
 * the live index and the package's `path-notifications.jsonl`.
 *
 * On Windows, `node:fs.watch` is backed by `ReadDirectoryChangesW`.
 * It does not give us the PID of the producer, only the file name and
 * the change kind. That is acknowledged and reported.
 */

import { watch, type FSWatcher } from "node:fs";
import type { PathNotification } from "../model/types.ts";

export interface FsWatcherOptions {
  root: string;
  onNotification: (n: PathNotification) => void;
  signal?: AbortSignal;
  /** Clock for notification timestamps. Defaults to process.hrtime.bigint(). */
  clock?: () => bigint;
}

export class FsWatcher {
  private watcher: FSWatcher | null = null;
  private renamePairs = new Map<string, { oldPath: string; at_ns: bigint }>();

  constructor(private opts: FsWatcherOptions) {}

  start(): void {
    this.watcher = watch(
      this.opts.root,
      { recursive: true, persistent: true },
      (eventType: string, filename: string | null) => this.handle(eventType, filename),
    );
    if (this.opts.signal) {
      this.opts.signal.addEventListener("abort", () => this.stop());
    }
  }

  private handle(eventType: string, filename: string | null): void {
    if (!filename) return;
    const path = normalizePath(this.opts.root, filename);
    const at_ns = this.opts.clock ? this.opts.clock() : process.hrtime.bigint();

    let kind: PathNotification["kind"];
    if (eventType === "rename") {
      // rename covers both create-after-delete and a rename event.
      // Windows behaviour: a real rename emits two events (delete old + create new).
      // We pair them by name without extension collision to a 250 ms window.
      const existing = this.renamePairs.get(path);
      if (existing) {
        const dt = at_ns - existing.at_ns;
        if (dt <= 250_000_000n) {
          this.opts.onNotification({
            timestamp_ns: at_ns,
            kind: "rename",
            path,
            oldPath: existing.oldPath,
            pid: null,
          });
          this.renamePairs.delete(path);
          return;
        }
      }
      // Otherwise: it could be a create. Inspect fs.stat to disambiguate.
      this.disambiguate(path, at_ns);
    } else if (eventType === "change") {
      this.opts.onNotification({
        timestamp_ns: at_ns,
        kind: "modify",
        path,
        oldPath: null,
        pid: null,
      });
    }
  }

  private async disambiguate(path: string, at_ns: bigint): Promise<void> {
    // Defer to the next tick to give the filesystem a chance to settle.
    await new Promise((r) => setTimeout(r, 10));
    const exists = await Bun.file(path).exists().catch(() => false);
    if (exists) {
      this.opts.onNotification({
        timestamp_ns: at_ns,
        kind: "create",
        path,
        oldPath: null,
        pid: null,
      });
    } else {
      // Treat as delete; record for potential rename pairing.
      this.renamePairs.set(path, { oldPath: path, at_ns });
    }
  }

  stop(): void {
    if (this.watcher) {
      try { this.watcher.close(); } catch { /* ignore */ }
      this.watcher = null;
    }
  }
}

function normalizePath(root: string, filename: string): string {
  // root + "\\" + filename, normalized to backslashes.
  return (root + "\\" + filename).replace(/\//g, "\\");
}
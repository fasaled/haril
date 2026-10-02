/**
 * `FileTimelineCommands` — the single product-level query service.
 *
 * TUI and MCP both call into this. It queries a `SqliteStore` and emits
 * paginated, structured results. No direct SQL beyond `SqliteStore`.
 *
 * Phase-1 lane memoization lives inside `SqliteStore` (a single SQL query
 * already materializes the directory's lanes as paths only, with no event
 * load). Per-lane event reads load at most one lane's events at a time
 * (DEC-033 of the original Haril).
 */

import type { SqliteStore } from "../store/sqlite.ts";
import type { BrowseFileTimelineRow, EventRow, FileActivitySummary, SessionOverview } from "../store/sqlite.ts";
import type { CommandResult, EventFilter, EventKind, Manifest, NormalizedEvent, FileKey } from "../model/types.ts";
import { fileKeyDisplay } from "../model/fileKey.ts";
import {
  computeHeuristicBridges,
  mergedLaneEvents,
  type AnnotatedTimelineLane,
  type FileTimelineLane,
} from "../model/heuristic.ts";

export const FILE_TIMELINE_PAGE_SIZE = 50;
export const FILE_TIMELINE_EVENTS_PER_FILE = 50;

export class FileTimelineCommands {
  constructor(private store: SqliteStore) {}

  private materializeLanes(opts: { directory: string; utcFrom?: bigint; utcTo?: bigint }): FileTimelineLane[] {
    // Pull all files under the directory (no path filter) and build lanes.
    const page = this.store.browseFileTimelines({
      directory: opts.directory,
      offset: 0,
      limit: 10000,
      utcFrom: opts.utcFrom,
      utcTo: opts.utcTo,
    });
    const lanes: FileTimelineLane[] = [];
    for (const row of page.items) {
      const events = this.store.inspectFileTimeline({
        fileKeyHash: row.fileKeyHash,
        offset: 0,
        limit: 10000,
      }).items.map(toNormalizedEvent);
      lanes.push({
        fileKey: rowToFileKey(row),
        displayPath: row.path ?? "",
        events,
      });
    }
    return lanes;
  }

  browseFileTimelines(opts: {
    directory: string;
    offset?: number;
    limit?: number;
    utcFrom?: bigint;
    utcTo?: bigint;
    pathPattern?: string;
    identityKind?: "exact" | "path";
  }): CommandResult {
    const limit = opts.limit ?? FILE_TIMELINE_PAGE_SIZE;
    const offset = opts.offset ?? 0;
    const page = this.store.browseFileTimelines({
      directory: opts.directory,
      offset,
      limit,
      utcFrom: opts.utcFrom,
      utcTo: opts.utcTo,
      pathPattern: opts.pathPattern,
      identityKind: opts.identityKind,
    });
    return {
      ok: true,
      kind: "json",
      data: {
        items: page.items.map((row) => ({
          fileKeyHash: row.fileKeyHash,
          display: fileKeyDisplay({
            kind: row.kind,
            volumeSerial: BigInt(row.volumeSerial ?? 0),
            fileId128: row.fileId128 ?? new Uint8Array(0),
            root: row.root ?? "",
            path: row.path ?? "",
          } as never),
          path: row.path,
          kind: row.kind,
          firstSeenNs: row.firstSeenNs,
          lastSeenNs: row.lastSeenNs,
          eventCount: row.eventCount,
        })),
        returnedCount: page.items.length,
        offset,
        hasMore: page.hasMore,
        nextOffset: page.nextOffset,
      },
    };
  }

  inspectFileTimeline(opts: {
    fileKeyHash: string;
    offset?: number;
    limit?: number;
    filter?: EventFilter;
  }): CommandResult {
    const limit = opts.limit ?? FILE_TIMELINE_EVENTS_PER_FILE;
    const offset = opts.offset ?? 0;
    const page = this.store.inspectFileTimeline({
      fileKeyHash: opts.fileKeyHash,
      offset,
      limit,
      opKinds: opts.filter?.opKinds,
      failedOnly: opts.filter?.failedOnly,
      pid: opts.filter?.pid,
      processName: opts.filter?.processName,
    });
    return {
      ok: true,
      kind: "json",
      data: {
        items: page.items.map((ev) => ({
          id: ev.id,
          timestampNs: ev.timestampNs,
          eventKind: ev.eventKind,
          pid: ev.pid,
          tid: ev.tid,
          processImageName: ev.processImageName,
          irpPtr: ev.irpPtr != null ? `0x${ev.irpPtr.toString(16)}` : null,
          ntStatus: ev.ntStatus,
          observedPath: ev.observedPath,
          byteOffset: ev.byteOffset,
          byteLength: ev.byteLength,
          shareAccess: ev.shareAccess,
          createOptions: ev.createOptions,
          createDisposition: ev.createDisposition,
          source: ev.source,
          sourceEventIndex: ev.sourceEventIndex,
        })),
        returnedCount: page.items.length,
        offset,
        hasMore: page.hasMore,
        nextOffset: page.nextOffset,
      },
    };
  }

  inspectFileTimelineEvent(opts: { fileKeyHash: string; eventIndex: number }): CommandResult {
    const row = this.store.inspectFileTimelineEvent(opts.fileKeyHash, opts.eventIndex);
    if (!row) {
      return {
        ok: false,
        kind: "error",
        error: `event id ${opts.eventIndex} not found in file timeline ${opts.fileKeyHash}`,
      };
    }
    return { ok: true, kind: "json", data: row };
  }

  searchFileTimelines(opts: { text: string; offset?: number; limit?: number }): CommandResult {
    const limit = opts.limit ?? FILE_TIMELINE_PAGE_SIZE;
    const offset = opts.offset ?? 0;
    const page = this.store.searchFileTimelines({ text: opts.text, offset, limit });
    return {
      ok: true,
      kind: "json",
      data: {
        items: page.items,
        returnedCount: page.items.length,
        offset,
        hasMore: page.hasMore,
        nextOffset: page.nextOffset,
      },
    };
  }

  getFileActivitySummary(opts: { fileKeyHash: string }): CommandResult {
    const summary = this.store.fileActivitySummary(opts.fileKeyHash);
    return { ok: true, kind: "json", data: summary };
  }

  getSessionActivityOverview(): CommandResult {
    const overview = this.store.sessionOverview();
    return { ok: true, kind: "json", data: overview };
  }

  listObservedDirectories(opts: { offset?: number; limit?: number }): CommandResult {
    const limit = opts.limit ?? FILE_TIMELINE_PAGE_SIZE;
    const offset = opts.offset ?? 0;
    const items = this.store.listDirectories(offset, limit);
    const hasMore = items.length > limit;
    const trimmed = items.slice(0, limit);
    return {
      ok: true,
      kind: "json",
      data: {
        items: trimmed,
        returnedCount: trimmed.length,
        offset,
        hasMore,
        nextOffset: offset + trimmed.length,
      },
    };
  }

  getFileSizeChanges(opts: { offset?: number; limit?: number }): CommandResult {
    return {
      ok: true,
      kind: "json",
      data: { message: "size_changes table is consulted directly; see getSessionActivityOverview and getFileActivitySummary" },
    };
  }

  browseHeuristicFileTimelines(opts: { directory: string; utcFrom?: bigint; utcTo?: bigint }): CommandResult {
    const lanes = this.materializeLanes({ directory: opts.directory, utcFrom: opts.utcFrom, utcTo: opts.utcTo });
    const annotated = computeHeuristicBridges(lanes);
    return {
      ok: true,
      kind: "json",
      data: {
        items: annotated.map((a) => ({
          fileKey: a.lane.fileKey,
          displayPath: a.lane.displayPath,
          eventCount: a.lane.events.length,
          bridgeCount: a.bridges.length,
          bridges: a.bridges.map((b) => ({
            kind: b.kind,
            atTimestamp_ns: b.atTimestamp_ns,
            sharedPath: b.sharedPath,
            samePid: b.samePid,
            fromLanePath: b.fromLane.displayPath,
            toLanePath: b.toLane.displayPath,
          })),
        })),
        returnedCount: annotated.length,
      },
    };
  }

  inspectHeuristicFileTimeline(opts: { fileKeyHash: string; merged: boolean }): CommandResult {
    // Look up the lane by fileKeyHash (hash of the FileKey).
    const lane = this.findLaneByHash(opts.fileKeyHash);
    if (!lane) {
      return { ok: false, kind: "error", error: `lane not found: ${opts.fileKeyHash}` };
    }
    const annotated = computeHeuristicBridges([lane]);
    if (opts.merged) {
      const merged = mergedLaneEvents(annotated, lane);
      return { ok: true, kind: "json", data: { merged } };
    }
    return { ok: true, kind: "json", data: { lane, bridges: annotated[0]?.bridges ?? [] } };
  }

  private findLaneByHash(fileKeyHash: string): FileTimelineLane | null {
    const row = this.store.getFilePathByHash(fileKeyHash);
    if (!row) return null;
    const events = this.store.inspectFileTimeline({
      fileKeyHash,
      offset: 0,
      limit: 10000,
    }).items.map(toNormalizedEvent);
    return {
      fileKey: { kind: row.kind as "exact" | "path", root: "", path: row.path ?? "" } as FileKey,
      displayPath: row.path ?? "",
      events,
    };
  }
}

function rowToFileKey(row: BrowseFileTimelineRow): FileKey {
  if (row.kind === "exact") {
    return {
      kind: "exact",
      volumeSerial: BigInt(row.volumeSerial ?? 0),
      fileId128: row.fileId128 ?? new Uint8Array(16),
    };
  }
  return { kind: "path", root: row.root ?? "", path: row.path ?? "" };
}

function toNormalizedEvent(row: EventRow): NormalizedEvent {
  return {
    timestamp_ns: BigInt(row.timestampNs),
    eventKind: row.eventKind,
    fileKey: row.fileKeyHash ? { kind: "path", root: "", path: row.fileKeyHash } : null,
    pid: row.pid,
    tid: row.tid,
    processImageName: row.processImageName,
    irpPtr: row.irpPtr != null ? BigInt(row.irpPtr) : null,
    ntStatus: row.ntStatus,
    observedPath: row.observedPath,
    byteOffset: row.byteOffset != null ? BigInt(row.byteOffset) : null,
    byteLength: row.byteLength,
    shareAccess: row.shareAccess,
    createOptions: row.createOptions,
    createDisposition: row.createDisposition,
    source: row.source,
    sourceEventIndex: row.sourceEventIndex,
  };
}
/**
 * SQLite-backed index used both as the live index during capture and as the
 * per-session analysis index rebuilt from a `.haril` package.
 *
 * The same store code opens both. Live mode is `live-capture`, the analysis
 * mode is `analyze`. The store is wrapped in a SQLite WAL transaction for
 * batched inserts.
 */

import { Database } from "bun:sqlite";
import { SCHEMA_SQL } from "./schema.ts";
import type { FileKey, NormalizedEvent, InventoryEntry, UsnRecord, PathNotification, EventKind, SourceId } from "../model/types.ts";
import { fileKeyHash } from "../model/fileKey.ts";

export interface StoreConfig {
  path?: string; // ":memory:" by default
}

export interface SizeChangeRow {
  fileKeyHash: string;
  initialLength: number | null;
  finalLength: number | null;
  initialPath: string | null;
  finalPath: string | null;
}

export interface BrowseFileTimelineRow {
  fileKeyHash: string;
  kind: "exact" | "path";
  path: string;
  root: string | null;
  volumeSerial: number | null;
  fileId128: Uint8Array | null;
  firstSeenNs: number;
  lastSeenNs: number;
  eventCount: number;
}

export interface EventRow {
  id: number;
  timestampNs: number;
  eventKind: EventKind;
  fileKeyHash: string | null;
  pid: number;
  tid: number;
  processImageName: string | null;
  irpPtr: number | null;
  ntStatus: number | null;
  observedPath: string | null;
  byteOffset: number | null;
  byteLength: number | null;
  shareAccess: number | null;
  createOptions: number | null;
  createDisposition: number | null;
  source: SourceId;
  sourceEventIndex: number;
}

export interface FileActivitySummary {
  fileKeyHash: string;
  firstSeenNs: number | null;
  lastSeenNs: number | null;
  eventCount: number;
  failedCount: number;
  operationCounts: Partial<Record<EventKind, number>>;
  distinctPids: number[];
  distinctProcessNames: string[];
  initialLength: number | null;
  finalLength: number | null;
}

export interface SessionOverview {
  totalEvents: number;
  totalFiles: number;
  totalUsn: number;
  totalNotifications: number;
  eventKindCounts: Partial<Record<EventKind, number>>;
  distinctProcessNames: string[];
  failedCount: number;
  captureWindow: { startedAtNs: number | null; stoppedAtNs: number | null };
}

export interface DirectoryEntry {
  directory: string;
  fileCount: number;
}

export class SqliteStore {
  private db: Database;
  private batchBuffer: NormalizedEvent[] = [];
  private batchSize = 500;
  private batchTimeoutMs = 250;
  private lastBatchAt = Date.now();
  private flushTimer: Timer | null = null;

  constructor(private cfg: StoreConfig = {}) {
    this.db = new Database(cfg.path ?? ":memory:");
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA_SQL);
  }

  close(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flush();
    this.db.close();
  }

  /** Insert or update a file row for a FileKey. */
  upsertFile(key: FileKey, timestamp_ns: bigint, observedPath?: string | null): void {
    const hash = fileKeyHash(key);
    const existing = this.db
      .query("SELECT first_seen_ns, path FROM files WHERE file_key_hash = ?")
      .get(hash) as { first_seen_ns: number; path: string | null } | null;
    const firstSeenNs = existing ? existing.first_seen_ns : Number(timestamp_ns);
    const filePath = existing?.path ?? observedPath ?? (key.kind === "path" ? key.path : null);

    if (key.kind === "exact") {
      const hi = Buffer.from(key.fileId128.slice(0, 8));
      const lo = Buffer.from(key.fileId128.slice(8, 16));
      this.db
        .query(
          `INSERT INTO files (file_key_hash, kind, volume_serial, file_id128_hi, file_id128_lo, root, path, first_seen_ns, last_seen_ns)
           VALUES (?, 'exact', ?, ?, ?, NULL, ?, ?, ?)
           ON CONFLICT(file_key_hash) DO UPDATE SET
             last_seen_ns = MAX(last_seen_ns, excluded.last_seen_ns),
             path = COALESCE(files.path, excluded.path)`,
        )
        .run(
          hash,
          Number(key.volumeSerial),
          hi,
          lo,
          filePath,
          firstSeenNs,
          Number(timestamp_ns),
        );
    } else {
      this.db
        .query(
          `INSERT INTO files (file_key_hash, kind, volume_serial, file_id128_hi, file_id128_lo, root, path, first_seen_ns, last_seen_ns)
           VALUES (?, 'path', NULL, NULL, NULL, ?, ?, ?, ?)
           ON CONFLICT(file_key_hash) DO UPDATE SET
             last_seen_ns = MAX(last_seen_ns, excluded.last_seen_ns),
             path = COALESCE(files.path, excluded.path)`,
        )
        .run(hash, key.root, filePath, firstSeenNs, Number(timestamp_ns));
    }
  }

  /** Queue an event for batched insert. */
  enqueueEvent(ev: NormalizedEvent): void {
    if (ev.fileKey) this.upsertFile(ev.fileKey, ev.timestamp_ns, ev.observedPath);
    this.batchBuffer.push(ev);
    if (this.batchBuffer.length >= this.batchSize) {
      this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flush();
      }, this.batchTimeoutMs);
    }
  }

  /** Flush any pending events to SQLite. */
  flush(): void {
    if (this.batchBuffer.length === 0) return;
    const events = this.batchBuffer;
    this.batchBuffer = [];
    this.lastBatchAt = Date.now();

    const insert = this.db.prepare(
      `INSERT INTO events (
        timestamp_ns, event_kind, file_key_hash, pid, tid, process_image_name,
        irp_ptr, nt_status, observed_path, byte_offset, byte_length,
        share_access, create_options, create_disposition, source, source_event_index
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertMany = this.db.transaction((rows: NormalizedEvent[]) => {
      for (const ev of rows) {
        insert.run(
          Number(ev.timestamp_ns),
          ev.eventKind,
          ev.fileKey ? fileKeyHash(ev.fileKey) : null,
          ev.pid,
          ev.tid,
          ev.processImageName,
          ev.irpPtr != null ? Number(ev.irpPtr) : null,
          ev.ntStatus,
          ev.observedPath,
          ev.byteOffset != null ? Number(ev.byteOffset) : null,
          ev.byteLength,
          ev.shareAccess,
          ev.createOptions,
          ev.createDisposition,
          ev.source,
          ev.sourceEventIndex,
        );
      }
    });
    insertMany(events);
  }

  insertInventoryEntries(entries: InventoryEntry[], isInitial: boolean): void {
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO inventory_entries
       (path, length, last_write_time_ns, creation_time_ns, file_id128_hi, file_id128_lo, volume_serial, observed_at_ns, is_initial)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = this.db.transaction((rows: InventoryEntry[]) => {
      for (const e of rows) {
        insert.run(
          e.path,
          e.length,
          Number(e.lastWriteTime),
          Number(e.creationTime),
          e.fileId128 ? Buffer.from(e.fileId128.slice(0, 8)) : null,
          e.fileId128 ? Buffer.from(e.fileId128.slice(8, 16)) : null,
          e.volumeSerial != null ? Number(e.volumeSerial) : null,
          Number(e.observedAt),
          isInitial ? 1 : 0,
        );
        if (e.fileId128 && e.volumeSerial != null) {
          this.upsertFile(
            { kind: "exact", volumeSerial: e.volumeSerial, fileId128: e.fileId128 },
            e.observedAt,
            e.path,
          );
        } else {
          this.upsertFile(
            { kind: "path", root: "", path: e.path },
            e.observedAt,
            e.path,
          );
        }
      }
    });
    tx(entries);
  }

  insertUsnRecord(record: UsnRecord, recordId: number): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO usn_records
         (record_id, usn, file_ref_number, parent_file_ref_number, file_id128_hi, file_id128_lo, reason, file_name, timestamp_ns)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        recordId,
        Number(record.usn),
        Number(record.fileReferenceNumber),
        Number(record.parentFileReferenceNumber),
        record.fileId128 ? Buffer.from(record.fileId128.slice(0, 8)) : null,
        record.fileId128 ? Buffer.from(record.fileId128.slice(8, 16)) : null,
        record.reason,
        record.fileName,
        Number(record.timestamp_ns),
      );
  }

  insertPathNotification(notif: PathNotification, id: number): void {
    this.db
      .query(
        `INSERT INTO path_notifications (id, timestamp_ns, kind, path, old_path, is_rename, pid)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        Number(notif.timestamp_ns),
        notif.kind,
        notif.path,
        notif.oldPath,
        notif.oldPath ? 1 : 0,
        notif.pid,
      );
  }

  /** Build size_changes by joining inventory entries with non-null FILE_ID_128. */
  computeSizeChanges(): void {
    this.db.exec("DELETE FROM size_changes;");
    this.db.exec(`
      INSERT INTO size_changes (file_key_hash, initial_length, final_length, initial_path, final_path)
      SELECT
        f.file_key_hash,
        i1.length AS initial_length,
        i2.length AS final_length,
        i1.path AS initial_path,
        i2.path AS final_path
      FROM inventory_entries i1
      JOIN inventory_entries i2
        ON i1.is_initial = 1 AND i2.is_initial = 0
        AND i1.path = i2.path
      JOIN files f
        ON f.path = i1.path;
    `);
  }

  setCoverage(opts: {
    startedAtNs: bigint;
    etwEventsObserved: number;
    etwEventsLost: number;
    usnRecordsRead: number;
    fswNotifications: number;
  }): void {
    this.db
      .query(
        `INSERT OR REPLACE INTO coverage (id, started_at_ns, stopped_at_ns, etw_events_observed, etw_events_lost, usn_records_read, fsw_notifications)
         VALUES (1, ?, NULL, ?, ?, ?, ?)`,
      )
      .run(
        Number(opts.startedAtNs),
        opts.etwEventsObserved,
        opts.etwEventsLost,
        opts.usnRecordsRead,
        opts.fswNotifications,
      );
  }

  finalizeCoverage(opts: { stoppedAtNs: bigint; etwEventsLost: number; usnRecordsRead: number; fswNotifications: number }): void {
    this.db
      .query(
        `UPDATE coverage SET stopped_at_ns = ?, etw_events_lost = ?, usn_records_read = ?, fsw_notifications = ? WHERE id = 1`,
      )
      .run(Number(opts.stoppedAtNs), opts.etwEventsLost, opts.usnRecordsRead, opts.fswNotifications);
  }

  // --- Queries ---

  listDirectories(offset: number, limit: number): DirectoryEntry[] {
    return this.db
      .query<DirectoryEntry, [number, number]>(
        `SELECT
           CASE
             WHEN instr(substr(path, 2), '\\') > 0
               THEN substr(path, 1, instr(substr(path, 2), '\\') + 1)
             ELSE path
           END AS directory,
           COUNT(*) AS fileCount
         FROM inventory_entries
         GROUP BY directory
         ORDER BY fileCount DESC, directory ASC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset);
  }

  browseFileTimelines(opts: {
    directory: string;
    offset: number;
    limit: number;
    utcFrom?: bigint;
    utcTo?: bigint;
    pathPattern?: string;
    identityKind?: "exact" | "path";
  }): { items: BrowseFileTimelineRow[]; hasMore: boolean; nextOffset: number } {
    const params: unknown[] = [];
    let where = "WHERE 1=1";

    const dirPrefix = normalizeDirPrefix(opts.directory);
    if (dirPrefix) {
      where += " AND f.path LIKE ? ESCAPE '|'";
      params.push(escapeLike(dirPrefix) + "%");
    }
    if (opts.identityKind === "exact") {
      where += " AND f.kind = 'exact'";
    } else if (opts.identityKind === "path") {
      where += " AND f.kind = 'path'";
    }
    if (opts.pathPattern) {
      where += " AND f.path LIKE ?";
      params.push("%" + opts.pathPattern.replace(/\*/g, "%") + "%");
    }
    if (opts.utcFrom != null || opts.utcTo != null) {
      where += " AND EXISTS (SELECT 1 FROM events e WHERE e.file_key_hash = f.file_key_hash";
      if (opts.utcFrom != null) {
        where += " AND e.timestamp_ns >= ?";
        params.push(Number(opts.utcFrom));
      }
      if (opts.utcTo != null) {
        where += " AND e.timestamp_ns <= ?";
        params.push(Number(opts.utcTo));
      }
      where += ")";
    }

    const sql = `
      SELECT
        f.file_key_hash AS fileKeyHash,
        f.kind AS kind,
        f.path AS path,
        f.root AS root,
        f.volume_serial AS volumeSerial,
        CASE WHEN f.file_id128_hi IS NOT NULL AND f.file_id128_lo IS NOT NULL
             THEN (f.file_id128_hi || f.file_id128_lo)
             ELSE NULL END AS fileId128,
        f.first_seen_ns AS firstSeenNs,
        f.last_seen_ns AS lastSeenNs,
        (SELECT COUNT(*) FROM events e WHERE e.file_key_hash = f.file_key_hash) AS eventCount
      FROM files f
      ${where}
      ORDER BY eventCount DESC, path ASC
      LIMIT ? OFFSET ?`;

    const items = this.db
      .query<BrowseFileTimelineRow & Record<string, unknown>, (string | number | null)[]>(sql)
      .all(...(params as (string | number | null)[]), opts.limit + 1, opts.offset);
    const hasMore = items.length > opts.limit;
    const trimmed = items.slice(0, opts.limit);
    return { items: trimmed, hasMore, nextOffset: opts.offset + trimmed.length };
  }

  inspectFileTimeline(opts: {
    fileKeyHash: string;
    offset: number;
    limit: number;
    opKinds?: EventKind[];
    failedOnly?: boolean;
    pid?: number;
    processName?: string;
  }): { items: EventRow[]; hasMore: boolean; nextOffset: number } {
    const params: unknown[] = [opts.fileKeyHash];
    let where = "WHERE e.file_key_hash = ?";
    if (opts.opKinds && opts.opKinds.length > 0) {
      where += ` AND e.event_kind IN (${opts.opKinds.map(() => "?").join(",")})`;
      params.push(...opts.opKinds);
    }
    if (opts.failedOnly) {
      where += " AND e.nt_status IS NOT NULL AND e.nt_status != 0";
    }
    if (opts.pid != null) {
      where += " AND e.pid = ?";
      params.push(opts.pid);
    }
    if (opts.processName) {
      where += " AND e.process_image_name LIKE ?";
      params.push("%" + opts.processName + "%");
    }

    const sql = `
      SELECT
        e.id AS id,
        e.timestamp_ns AS timestampNs,
        e.event_kind AS eventKind,
        e.file_key_hash AS fileKeyHash,
        e.pid AS pid,
        e.tid AS tid,
        e.process_image_name AS processImageName,
        e.irp_ptr AS irpPtr,
        e.nt_status AS ntStatus,
        e.observed_path AS observedPath,
        e.byte_offset AS byteOffset,
        e.byte_length AS byteLength,
        e.share_access AS shareAccess,
        e.create_options AS createOptions,
        e.create_disposition AS createDisposition,
        e.source AS source,
        e.source_event_index AS sourceEventIndex
      FROM events e
      ${where}
      ORDER BY e.timestamp_ns ASC
      LIMIT ? OFFSET ?`;

    const items = this.db
      .query<EventRow & Record<string, unknown>, (string | number | null)[]>(sql)
      .all(...(params as (string | number | null)[]), opts.limit + 1, opts.offset);
    const hasMore = items.length > opts.limit;
    const trimmed = items.slice(0, opts.limit);
    return { items: trimmed, hasMore, nextOffset: opts.offset + trimmed.length };
  }

  inspectFileTimelineEvent(fileKeyHash: string, eventIndex: number): EventRow | null {
    const row = this.db
      .query<EventRow & Record<string, unknown>, [string, number]>(
        `SELECT
          e.id AS id,
          e.timestamp_ns AS timestampNs,
          e.event_kind AS eventKind,
          e.file_key_hash AS fileKeyHash,
          e.pid AS pid,
          e.tid AS tid,
          e.process_image_name AS processImageName,
          e.irp_ptr AS irpPtr,
          e.nt_status AS ntStatus,
          e.observed_path AS observedPath,
          e.byte_offset AS byteOffset,
          e.byte_length AS byteLength,
          e.share_access AS shareAccess,
          e.create_options AS createOptions,
          e.create_disposition AS createDisposition,
          e.source AS source,
          e.source_event_index AS sourceEventIndex
        FROM events e
        WHERE e.file_key_hash = ? AND e.id = ?`,
      )
      .get(fileKeyHash, eventIndex);
    return row ?? null;
  }

  searchFileTimelines(opts: { text: string; offset: number; limit: number }): {
    items: BrowseFileTimelineRow[];
    hasMore: boolean;
    nextOffset: number;
  } {
    const like = "%" + opts.text + "%";
    const items = this.db
      .query<BrowseFileTimelineRow & Record<string, unknown>, (string | number)[]>(
        `SELECT DISTINCT
            f.file_key_hash AS fileKeyHash,
            f.kind AS kind,
            f.path AS path,
            f.root AS root,
            f.volume_serial AS volumeSerial,
            CASE WHEN f.file_id128_hi IS NOT NULL AND f.file_id128_lo IS NOT NULL
                 THEN (f.file_id128_hi || f.file_id128_lo)
                 ELSE NULL END AS fileId128,
            f.first_seen_ns AS firstSeenNs,
            f.last_seen_ns AS lastSeenNs,
            (SELECT COUNT(*) FROM events e WHERE e.file_key_hash = f.file_key_hash) AS eventCount
          FROM files f
          LEFT JOIN events e ON e.file_key_hash = f.file_key_hash
          WHERE f.path LIKE ?
             OR e.process_image_name LIKE ?
          ORDER BY eventCount DESC, f.path ASC
          LIMIT ? OFFSET ?`,
      )
      .all(like, like, opts.limit + 1, opts.offset);
    const hasMore = items.length > opts.limit;
    const trimmed = items.slice(0, opts.limit);
    return { items: trimmed, hasMore, nextOffset: opts.offset + trimmed.length };
  }

  fileActivitySummary(fileKeyHash: string): FileActivitySummary {
    const range = this.db
      .query<{ firstSeenNs: number | null; lastSeenNs: number | null }, [string]>(
        `SELECT MIN(timestamp_ns) AS firstSeenNs, MAX(timestamp_ns) AS lastSeenNs FROM events WHERE file_key_hash = ?`,
      )
      .get(fileKeyHash);
    const count = this.db
      .query<{ n: number }, [string]>(`SELECT COUNT(*) AS n FROM events WHERE file_key_hash = ?`)
      .get(fileKeyHash);
    const failed = this.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM events WHERE file_key_hash = ? AND nt_status IS NOT NULL AND nt_status != 0`,
      )
      .get(fileKeyHash);
    const kinds = this.db
      .query<{ event_kind: string; n: number }, [string]>(
        `SELECT event_kind, COUNT(*) AS n FROM events WHERE file_key_hash = ? GROUP BY event_kind`,
      )
      .all(fileKeyHash);
    const pids = this.db
      .query<{ pid: number }, [string]>(
        `SELECT DISTINCT pid FROM events WHERE file_key_hash = ? ORDER BY pid`,
      )
      .all(fileKeyHash);
    const names = this.db
      .query<{ process_image_name: string | null }, [string]>(
        `SELECT DISTINCT process_image_name FROM events WHERE file_key_hash = ? AND process_image_name IS NOT NULL ORDER BY process_image_name`,
      )
      .all(fileKeyHash);
    const sizes = this.db
      .query<{ initial_length: number | null; final_length: number | null }, [string]>(
        `SELECT initial_length, final_length FROM size_changes WHERE file_key_hash = ?`,
      )
      .get(fileKeyHash);

    const operationCounts: Partial<Record<EventKind, number>> = {};
    for (const row of kinds) operationCounts[row.event_kind as EventKind] = row.n;

    return {
      fileKeyHash,
      firstSeenNs: range?.firstSeenNs ?? null,
      lastSeenNs: range?.lastSeenNs ?? null,
      eventCount: count?.n ?? 0,
      failedCount: failed?.n ?? 0,
      operationCounts,
      distinctPids: pids.map((r) => r.pid),
      distinctProcessNames: names.map((r) => r.process_image_name).filter((n): n is string => n != null),
      initialLength: sizes?.initial_length ?? null,
      finalLength: sizes?.final_length ?? null,
    };
  }

  sessionOverview(): SessionOverview {
    const events = this.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM events`).get();
    const files = this.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM files`).get();
    const usn = this.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM usn_records`).get();
    const notifs = this.db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM path_notifications`).get();
    const kinds = this.db
      .query<{ event_kind: string; n: number }, []>(
        `SELECT event_kind, COUNT(*) AS n FROM events GROUP BY event_kind`,
      )
      .all();
    const failed = this.db
      .query<{ n: number }, []>(
        `SELECT COUNT(*) AS n FROM events WHERE nt_status IS NOT NULL AND nt_status != 0`,
      )
      .get();
    const names = this.db
      .query<{ process_image_name: string | null }, []>(
        `SELECT DISTINCT process_image_name FROM events WHERE process_image_name IS NOT NULL`,
      )
      .all();
    const cov = this.db
      .query<{ started_at_ns: number | null; stopped_at_ns: number | null }, []>(
        `SELECT started_at_ns, stopped_at_ns FROM coverage WHERE id = 1`,
      )
      .get();

    const operationCounts: Partial<Record<EventKind, number>> = {};
    for (const row of kinds) operationCounts[row.event_kind as EventKind] = row.n;

    return {
      totalEvents: events?.n ?? 0,
      totalFiles: files?.n ?? 0,
      totalUsn: usn?.n ?? 0,
      totalNotifications: notifs?.n ?? 0,
      eventKindCounts: operationCounts,
      distinctProcessNames: names.map((r) => r.process_image_name).filter((n): n is string => n != null),
      failedCount: failed?.n ?? 0,
      captureWindow: {
        startedAtNs: cov?.started_at_ns ?? null,
        stoppedAtNs: cov?.stopped_at_ns ?? null,
      },
    };
  }

  getFilePathByHash(fileKeyHash: string): { path: string | null; kind: string } | null {
    const row = this.db
      .query<{ path: string | null; kind: string }, [string]>(`SELECT path, kind FROM files WHERE file_key_hash = ?`)
      .get(fileKeyHash);
    return row ?? null;
  }

  getFileByPath(filePath: string): { fileKeyHash: string; path: string } | null {
    const normalized = filePath.replace(/\//g, "\\");
    const row = this.db
      .query<{ fileKeyHash: string; path: string }, [string, string]>(
        `SELECT file_key_hash AS fileKeyHash, path FROM files WHERE path = ? OR path LIKE ? LIMIT 1`,
      )
      .get(normalized, "%" + normalized);
    return row ?? null;
  }

  getEventById(id: number): EventRow | null {
    const row = this.db
      .query<EventRow & Record<string, unknown>, [number]>(
        `SELECT
          e.id AS id,
          e.timestamp_ns AS timestampNs,
          e.event_kind AS eventKind,
          e.file_key_hash AS fileKeyHash,
          e.pid AS pid,
          e.tid AS tid,
          e.process_image_name AS processImageName,
          e.irp_ptr AS irpPtr,
          e.nt_status AS ntStatus,
          e.observed_path AS observedPath,
          e.byte_offset AS byteOffset,
          e.byte_length AS byteLength,
          e.share_access AS shareAccess,
          e.create_options AS createOptions,
          e.create_disposition AS createDisposition,
          e.source AS source,
          e.source_event_index AS sourceEventIndex
        FROM events e
        WHERE e.id = ?`,
      )
      .get(id);
    return row ?? null;
  }

  getCoverage() {
    return (
      this.db
        .query<
          {
            started_at_ns: number | null;
            stopped_at_ns: number | null;
            etw_events_observed: number | null;
            etw_events_lost: number | null;
            usn_records_read: number | null;
            fsw_notifications: number | null;
          },
          []
        >(
          `SELECT started_at_ns, stopped_at_ns, etw_events_observed, etw_events_lost, usn_records_read, fsw_notifications FROM coverage WHERE id = 1`,
        )
        .get() ?? null
    );
  }
}
/**
 * Root-relative directory (`\`, `\sub`, `sub\dir`) to a LIKE prefix
 * (`\sub\`). Returns null for the capture root, which matches everything.
 */
export function normalizeDirPrefix(directory: string | undefined): string | null {
  if (!directory) return null;
  const parts = directory.replace(/\//g, "\\").split("\\").filter((p) => p.length > 0 && p !== ".");
  if (parts.length === 0) return null;
  return "\\" + parts.join("\\") + "\\";
}

function escapeLike(s: string): string {
  return s.replace(/[|%_]/g, (c) => "|" + c);
}

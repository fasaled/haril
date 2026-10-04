/**
 * SQLite schema (DDL) used both for the live index during capture and for
 * the temporary analysis index built when a `.haril` package is opened.
 *
 * Same schema: the analysis queries do not care whether the index is being
 * filled in real time or reconstructed from a package.
 */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS files (
  file_key_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  volume_serial INTEGER,
  file_id128_hi BLOB,
  file_id128_lo BLOB,
  root TEXT,
  path TEXT,
  first_seen_ns INTEGER NOT NULL,
  last_seen_ns INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  timestamp_ns INTEGER NOT NULL,
  event_kind TEXT NOT NULL,
  file_key_hash TEXT REFERENCES files(file_key_hash),
  pid INTEGER NOT NULL,
  tid INTEGER NOT NULL,
  process_image_name TEXT,
  irp_ptr INTEGER,
  nt_status INTEGER,
  observed_path TEXT,
  byte_offset INTEGER,
  byte_length INTEGER,
  share_access INTEGER,
  create_options INTEGER,
  create_disposition INTEGER,
  source TEXT NOT NULL,
  source_event_index INTEGER
);

CREATE INDEX IF NOT EXISTS events_file_ts ON events(file_key_hash, timestamp_ns);
CREATE INDEX IF NOT EXISTS events_pid_ts ON events(pid, timestamp_ns);
CREATE INDEX IF NOT EXISTS events_source_ts ON events(source, timestamp_ns);

CREATE TABLE IF NOT EXISTS inventory_entries (
  path TEXT NOT NULL,
  length INTEGER NOT NULL,
  last_write_time_ns INTEGER,
  creation_time_ns INTEGER,
  file_id128_hi BLOB,
  file_id128_lo BLOB,
  volume_serial INTEGER,
  observed_at_ns INTEGER NOT NULL,
  is_initial INTEGER NOT NULL,
  PRIMARY KEY (path, is_initial)
);

CREATE TABLE IF NOT EXISTS usn_records (
  record_id INTEGER PRIMARY KEY,
  usn INTEGER NOT NULL,
  file_ref_number INTEGER NOT NULL,
  parent_file_ref_number INTEGER NOT NULL,
  file_id128_hi BLOB,
  file_id128_lo BLOB,
  reason INTEGER NOT NULL,
  file_name TEXT NOT NULL,
  timestamp_ns INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS usn_frn ON usn_records(file_ref_number);

CREATE TABLE IF NOT EXISTS path_notifications (
  id INTEGER PRIMARY KEY,
  timestamp_ns INTEGER NOT NULL,
  kind TEXT NOT NULL,
  path TEXT NOT NULL,
  old_path TEXT,
  is_rename INTEGER NOT NULL DEFAULT 0,
  pid INTEGER
);

CREATE TABLE IF NOT EXISTS coverage (
  id INTEGER PRIMARY KEY,
  started_at_ns INTEGER NOT NULL,
  stopped_at_ns INTEGER,
  etw_events_observed INTEGER DEFAULT 0,
  etw_events_lost INTEGER DEFAULT 0,
  usn_records_read INTEGER DEFAULT 0,
  fsw_notifications INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS size_changes (
  file_key_hash TEXT PRIMARY KEY,
  initial_length INTEGER,
  final_length INTEGER,
  initial_path TEXT,
  final_path TEXT
);

CREATE TABLE IF NOT EXISTS session_meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;
# Haril-TS — Design

Living spec. Implement against this document.

Haril-TS reconstructs the observable lifecycle of files in a single
directory tree on NTFS Windows, during a 1–300 s capture window. It
combines:

- Windows Kernel ETW (`Microsoft-Windows-Kernel-File`,
  `Microsoft-Windows-Kernel-Process`,
  `Microsoft-Windows-Kernel-Image`).
- NTFS USN Journal (`FSCTL_READ_USN_JOURNAL`).
- FileSystemWatcher (user-mode).

…and produces a portable `.haril` archive (ZIP + JSONL streams + SHA-256
manifest). The same archive can be opened in another machine for
analysis. The same `FileTimelineCommands` query service powers both
the TUI (Ink + React) and an MCP stdio server.

## Architecture

```
                ┌────────────────────────────────────────┐
                │         TUI (Ink / React)             │
                │   Header, Timeline, File, Event,      │
                │   Activity Panel, Status, Prompt      │
                └────────────────┬───────────────────────┘
                                 │ run(line) / snapshot()
                ┌────────────────▼───────────────────────┐
                │     @haril-ts/core — HarilSession      │
                │   parse → dispatch → commands/file_   │
                │   timeline → SqliteStore (bun:sqlite) │
                └────────────────┬───────────────────────┘
                                 │ dlopen (optional)
                ┌────────────────▼───────────────────────┐
                │   haril_native.dll (C++ via zig cc)   │
                │   ETW StartTrace + TdhGetEventInfo    │
                │   USN FSCTL_READ_USN_JOURNAL          │
                │   SPSC ring buffer → TS poll          │
                │   IsUserAnAdmin + ShellExecuteExW(runas) │
                └────────────────────────────────────────┘
```

Two clients share the same `FileTimelineCommands`:

| Client | Process | Session |
|---|---|---|
| TUI | `haril` | empty / live-capture / analyze |
| MCP | `haril mcp [path.haril] [--events <journal>]` | opens a `.haril` via `open_capture_package`, replaces on each call |
| One-shot | (none — by design; original DEC-048) | n/a |

## Phases

The TUI has three phases, controlled entirely by the command prompt:

| Phase | Entry | Exit |
|---|---|---|
| **empty** | `haril` (no args) | `open <path.haril>` → analyze; `start-capture …` → live-capture |
| **live-capture** | `start-capture --root <dir> --output <file.haril> --seconds <n>` | `stop-capture` → analyze; `force-quit-capture` → empty |
| **analyze** | `open <path.haril>` | `close` → empty |

The header, status bar, and prompt hint update to reflect the active
phase.

## `.haril` package

ZIP with STORE compression. Entries:

| Entry | Role |
|---|---|
| `manifest.json` | schemaVersion, sessionId, root, fsKind, sources, recordCounts, sha256 per entry |
| `inventory.jsonl` | initial file inventory with `FILE_ID_INFO` |
| `final-inventory.jsonl` | final inventory |
| `events.jsonl` | normalized operations (Create/Open/Read/Write/SetInfo/Rename/Delete/Close/OpEnd/Notify) |
| `source-events.jsonl` | decoded ETW/USN/FSW source payloads |
| `path-notifications.jsonl` | FSW callback observations and rename pairs |
| `usn-events.jsonl` | NTFS change journal records |

`fsKind: "ntfs"` is required. Non-NTFS packages are rejected at import
time.

## SQLite schema

Same for live and analysis indexes:

- `files(file_key_hash PK, kind, volume_serial, file_id128_hi, file_id128_lo, root, path, first_seen_ns, last_seen_ns)`
- `events(id PK, timestamp_ns, event_kind, file_key_hash, pid, tid, process_image_name, irp_ptr, nt_status, observed_path, byte_offset, byte_length, share_access, create_options, create_disposition, source, source_event_index)`
- `inventory_entries(path PK, length, …, is_initial)`
- `usn_records(record_id PK, …)`
- `path_notifications(id PK, …)`
- `coverage(id PK, started_at_ns, stopped_at_ns, etw_events_observed, etw_events_lost, …)`
- `size_changes(file_key_hash PK, initial_length, final_length, initial_path, final_path)`

Indexes: `events(file_key_hash, timestamp_ns)`, `events(pid,
timestamp_ns)`, `events(source, timestamp_ns)`, `usn_records(file_ref_number)`.

## Command core

Pure handlers in `packages/core/src/commands/`:

| Command | Source |
|---|---|
| `ls [path] [--pattern] [--identity]` | `file_timeline.browseFileTimelines` |
| `cd <dir>`, `pwd`, `close` | session |
| `events [<fileKey>] [--op] [--failed] [--pid] [--process] [reset]` | `file_timeline.inspectFileTimeline` |
| `evidence [<eventKey>]` | `file_timeline.inspectFileTimelineEvent` |
| `summary [<fileKey>]` | `file_timeline.getFileActivitySummary` |
| `search <text>` | `file_timeline.searchFileTimelines` |
| `overview` | `file_timeline.getSessionActivityOverview` |
| `dirs` | `file_timeline.listObservedDirectories` |
| `size-changes` | derived from `inventory_entries` |
| `capture` | returns the manifest in the activity panel |
| `heuristics [on\|off]` | session toggle |
| `zoom [in\|out\|reset]` | session toggle |
| `start-capture`, `stop-capture`, `force-quit-capture` | phase transitions |
| `queue`, `cancel`, `help`, `quit`, `exit` | session / UI |

Pagination envelope: `{ items, returnedCount, offset, hasMore, nextOffset }`.

## ETW decoding

`TdhGetEventInformation` is invoked on demand for each
`(ProviderGuid, EventDescriptor.Id, EventDescriptor.Version)` tuple,
in the ETW consumer thread, inside the `EventRecordCallback`. The
returned `TRACE_EVENT_INFO` describes:

- The first `TDH_INTYPE_UNICODESTRING` property as the observed path.
- Any `TDH_INTYPE_GUID` property as `fileId128`.

This is **not** a generic MOF parser. It is schemadriven: a Windows
update that changes a layout does not break us, because TDH follows
the published schema and we ignore unknown fields.

The legacy `FileIo/Name` event id 0 keeps a fixed-offset fallback
(it does not carry an embedded schema).

## USN reader

A thread calls `DeviceIoControl(FSCTL_READ_USN_JOURNAL)` in a loop with a
1 MiB buffer. `USN_RECORD_V2` is parsed in place; if a record carries
`FileId128` (V4) we extract it too.

## Elevation

`IsUserAnAdmin` is implemented via `CheckTokenMembership` against the
built-in administrators SID (more reliable than the `Shell32` helper).

`ShellExecuteExW(Verb="runas")` is wrapped in `haril_relaunch_elevated`
inside the native DLL, which calls `CoInitializeEx` before and
`CoUninitialize` after, satisfying the COM init requirement from MSDN.

## Graceful degradation

The native DLL is **optional**. Without it, the TUI/MCP can open and
analyze `.haril` packages but cannot capture or query identity. This
keeps the project working on any machine, including non-Windows hosts
for development.

## Heuristic view (DEC-035)

Off by default. When enabled, computes in memory only:

- `delete → recreate` on the same path within 1000 ms.
- `temporary file → rename` in the same directory within 1000 ms.

Each merged lane is labelled `[inferred]`. Bridge events use
`RelationBasis = InferredRecreation` or `InferredAtomicReplacement`.
The view is opt-in via `heuristics on` or `v`.

## Shell completion

`haril completion bash|zsh|fish|powershell` prints a script. No
postinstall hook.
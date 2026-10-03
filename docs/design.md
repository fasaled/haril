# Haril-TS — Design

Living specification. Implement against this document.

## Project Overview

Haril-TS reconstructs the observable lifecycle of files in a single directory tree on NTFS Windows, during a 1–300 second capture window. It produces a portable `.haril` archive (ZIP + JSONL streams + SHA-256 manifest) that can be opened on another machine for analysis. The same `FileTimelineCommands` query service powers both the TUI (Ink + React) and an MCP stdio server.

The project is self-contained: all source code, build scripts, and documentation live in this repository. No external projects or prior knowledge of other tools is required to understand or use Haril-TS.

## Architecture

```
                ┌────────────────────────────────────────┐
                │ TUI (Ink / React)                      │
                │ Header, Timeline, File, Event,          │
                │ Activity Panel, Status, Prompt          │
                └────────────────┬───────────────────────┘
                                 │ run(line) / snapshot()
                ┌────────────────▼───────────────────────┐
                │ HarilSession — core query service       │
                │ parse → dispatch → commands/file_timeline│
                │ → SqliteStore (bun:sqlite)              │
                └────────────────┬───────────────────────┘
                                 │ optional native addon
                ┌────────────────▼───────────────────────┐
                │ haril_native.node (C++ via MSBuild)     │
                │ ETW capture + USN + FSW callbacks       │
                │ Manual MOF-offset parser                │
                └────────────────────────────────────────┘
```

Two clients share the same `FileTimelineCommands`:

| Client | Process | Session |
|---|---|---|
| TUI | `haril` (standalone binary) | empty / live-capture / analyze |
| MCP | `haril mcp [path.haril] [--events <journal>]` | opens a `.haril` package |

One-shot ad-hoc use is not supported by design.

## Phases

The TUI has three phases, controlled entirely by the command prompt:

| Phase | Entry Command | Exit Command |
|---|---|---|
| **empty** | `haril` (no args) | `open <path.haril>` → analyze; `start-capture …` → live-capture |
| **live-capture** | `start-capture --root <dir> --output <file.haril> --seconds <n>` | `stop-capture` → analyze; `force-quit-capture` → empty |
| **analyze** | `open <path.haril>` | `close` → empty |

The header, status bar, and prompt hint update to reflect the active phase.

## `.haril` package format

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

`fsKind: "ntfs"` is required. Non-NTFS packages are rejected at import time.

## SQLite schema (same for live and analysis indexes)

- `files(file_key_hash PK, kind, volume_serial, file_id128_hi, file_id128_lo, root, path, first_seen_ns, last_seen_ns)`
- `events(id PK, timestamp_ns, event_kind, file_key_hash, pid, tid, process_image_name, irp_ptr, nt_status, observed_path, byte_offset, byte_length, share_access, create_options, create_disposition, source, source_event_index)`
- `inventory_entries(path PK, length, …, is_initial)`
- `usn_records(record_id PK, …)`
- `path_notifications(id PK, …)`
- `coverage(id PK, started_at_ns, stopped_at_ns, etw_events_observed, etw_events_lost, …)`
- `size_changes(file_key_hash PK, initial_length, final_length, initial_path, final_path)`

Indexes: `events(file_key_hash, timestamp_ns)`, `events(pid, timestamp_ns)`, `events(source, timestamp_ns)`, `usn_records(file_ref_number)`.

## Command core

Pure handlers in `packages/core/src/commands/`:

| Command | Description |
|---|---|
| `ls [path] [--pattern] [--identity]` | Browse file timelines |
| `cd <dir>`, `pwd`, `close` | Navigate and close package |
| `events [<fileKey>] [--op] [--failed] [--pid] [--process] [reset]` | Inspect file timeline |
| `evidence [<eventKey>]` | Inspect a specific event |
| `summary [<fileKey>]` | Get file activity summary |
| `search <text>` | Search file timelines |
| `overview` | Get session activity overview |
| `dirs` | List observed directories |
| `size-changes` | Derived from inventory entries |
| `capture` | Returns the manifest in the activity panel |
| `heuristics [on\|off]` | Session toggle (computes inferred bridges in memory) |
| `zoom [in\|out\|reset]` | Session toggle |
| `start-capture`, `stop-capture`, `force-quit-capture` | Phase transitions |
| `queue`, `cancel`, `help`, `quit`, `exit` | Session / UI support |

Pagination envelope: `{ items, returnedCount, offset, hasMore, nextOffset }`.

## ETW decoding

The native addon (`haril_native.node`) captures ETW events via the Windows Kernel Logger API. The `EventRecordCallback` receives raw event blobs which are decoded using a **manual MOF-offset parser** discovered empirically. This avoids the `TdhGetEventInformation`/`TdhFormatProperty` path which fails with `ERROR_NOT_FOUND` (1168) for kernel MOF events.

The layout offsets discovered are:
- [0..8) = FileObject
- [8..16) = IrpPtr
- [16..20) = createOptions
- [20..24) = createDisposition
- [24..28) = shareAccess
- [32..) = FileName (UTF-16 NUL-terminado)

The `map_kind()` function maps opcode values to event kinds for both the Manifest provider and MOF Kernel FileIo provider.

## USN reader

A thread calls `DeviceIoControl(FSCTL_READ_USN_JOURNAL)` in a loop with a 1 MiB buffer. `USN_RECORD_V2` is parsed in place; if a record carries `FileId128` (V4) we extract it too. USN identity fields travel in the slot extension block at offsets [176..204].

## Elevation

`IsUserAnAdmin` is implemented via `CheckTokenMembership` against the built-in administrators SID.

`ShellExecuteExW(Verb="runas")` is wrapped inside the native addon, which calls `CoInitializeEx` before and `CoUninitialize` after.

## Graceful degradation

On Windows, the native addon (`haril_native.node`) is **required** for capture functionality (ETW + USN journal + FSW callbacks). Without it, the TUI `start-capture` command returns an error and no live capture is possible. However, opening and analyzing existing `.haril` packages still works — the TUI enters analyze phase with a summary indicating the addon is missing.

On non-Windows hosts (macOS, Linux), the native addon is not built and the project degrades fully: no capture (those OSes don't have NTFS/ETW/USN in the same way), but `.haril` analysis packages opened from Windows can be inspected, searched, and summarized.

This keeps the project cross-platform for analysis-only use cases while ensuring Windows capture always requires the native addin.

## Heuristic view

Off by default. When enabled, computes in memory only:
- `delete → recreate` on the same path within 1000 ms.
- `temporary file → rename` in the same directory within 1000 ms.

Each merged lane is labelled `[inferred]`. Bridge events use `RelationBasis = InferredRecreation` or `InferredAtomicReplacement`. The view is opt-in via `heuristics on` or `v`.

## Shell completion

`haril completion bash|zsh|fish|powershell` prints a script. No postinstall hook.

---
*This is a standalone project. No prior knowledge of other tools or projects is required to understand or use Haril-TS.*
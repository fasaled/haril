# Haril-TS — Decisions

Architecture decisions, in the format `Context / Decision / Consequences`.

## DEC-001 — Workspace structure: core (private) + cli (public)

**Context:** This project has two npm workspace members. One exports the core logic (`@haril-ts/core`), the other provides the public CLI binary (`@haril-ts/cli`, entry `haril`).

**Decision:** `packages/core` contains pure logic: model, store, commands, package format, native-addon loader. `packages/cli` contains the TUI (Ink + React), MCP server, and shell completion. They share one source of truth: `HarilSession.run(line)`.

**Consequences:** Clear separation of concerns. The TUI and MCP both call into `FileTimelineCommands`. The native addon is optional at runtime — without it, the JS code degrades gracefully and you can still run the test suite and analyze packages.

## DEC-002 — Single command core; TUI and MCP are thin adapters

**Decision:** `FileTimelineCommands` is the single product-level query service. TUI and MCP both call into it. There is no separate `haril capture` or `haril analyze` CLI — capture and analysis are triggered through the TUI prompt or the MCP stdio interface.

**Consequences:** Consistency — every query goes through the same codepath. Simpler maintenance: changes to query behavior affect both clients automatically.

## DEC-003 — Shebang and runtime

The published binary runs under Bun (1.3+) or Node (20+). `bun:sqlite` is Bun-only; for Node runtimes we'd need `better-sqlite3`. This project targets Bun as the primary runtime.

**Consequences:** Development uses Bun for tests and build. The published `.exe` bundles JS via `bun build --compile` for Windows.

## DEC-006 — Ink 7.1.1 + React 19.3.0

Style is aligned with modern terminal UI conventions. No Solid, no OpenTUI.

**Consequences:** Component library matches the conventions of projects like `fasaled/muin` and `fasaled/sailkari` in look-and-feel, but is implemented independently.

## DEC-007 — No separate `haril capture` or `haril analyze` CLI

**Decision:** `start-capture` is a TUI command. The MCP uses `haril mcp [path.haril] [--events <journal>]`. There is no standalone `haril capture` or `haril analyze` commands.

**Consequences:** Users interact through the TUI prompt or the MCP stdio server. The binary `haril` defaults to the TUI when invoked with no arguments.

## DEC-008 — Auto-relaunch via `ShellExecuteExW(Verb="runas")`

**Decision:** Run as administrator is implemented by starting a new process with `ShellExecuteExW(Verb="runas")`. The original process writes a pending-session file (`%LOCALAPPDATA%/Haril/pending-session.json`) so the relaunched instance can resume the previous state.

**Consequences:** Users on Windows are automatically prompted for elevation when a command requires admin rights (USN journal capture, certain file operations). The pending-session mechanism ensures no data is lost during the elevation transition.

## DEC-010 — Command prompt always visible with completion menu

**Decision:** The command prompt is always visible at the bottom of the TUI, with a vertical completion menu suggesting available commands based on the current phase. This is DEC-050/052 of the original reference project, reimplemented independently.

**Consequences:** Discoverability — users can see available commands at a glance. The prompt hint updates per phase (empty / live-capture / analyze).

## DEC-011 — Activity panel replaces command overlay

**Decision:** An activity panel displays captured events and operations, replacing a simple command overlay. This provides context about what's being captured or has been captured, without cluttering the command area.

**Consequences:** Better UX — users see a history of operations, can interact with entries, and the panel is togglable.

## DEC-013 — Heuristic view (off by default)

**Decision:** When enabled, computes in memory only two rules:
- `delete → recreate` on the same path within 1000 ms.
- `temporary file → rename` in the same directory within 1000 ms.

Each merged lane is labelled `[inferred]`. Bridge events use `RelationBasis = InferredRecreation` or `InferredAtomicReplacement`. The view is opt-in via `heuristics on` or `v`.

**Consequences:** Helps identify rapid file lifecycle events without persisting them to the package. Computed purely in memory.

## DEC-015 — Windows-only, NTFS-only

**Decision:** This project captures the filesystem lifecycle on NTFS Windows only. Non-NTFS volumes are rejected at import time. The `.haril` package requires `fsKind: "ntfs"`.

**Consequences:** The project does not run on macOS, Linux, or non-NTFS Windows file systems for capture. Analysis of existing `.haril` packages may work cross-platform if the data was created on NTFS.

## DEC-017 — Native addon: manual MOF-offset parser instead of TDH

**Context:** `TdhGetEventInformation` fails with `ERROR_NOT_FOUND` (1168) for kernel-mode MOF events. An early empirical parser read a FileName at offset 32 for every opcode, which is only valid for `FileIo_Create`; other opcodes produced garbage paths and Read/Write/Close never resolved.

**Decision:** Parse the documented `FileIo_*` layouts per opcode (see `docs/design.md`, "ETW decoding"). Create (64) and Name/Rundown (0/32/36) carry paths; Read/Write/SetInfo/Delete/Rename/Close are resolved through `FileObject -> path` and `FileKey -> path` maps kept on the ProcessTrace thread.

**Consequences:**
- No dependency on Windows MOF schemas that change between updates.
- Full per-file activity (Create/Open/Read/Write/Rename/Delete/Close) attributed to a pid and process name.
- 32-bit producer events (4-byte pointers) are ignored.
## DEC-019 — `ShellExecuteExW` requires COM init

**Decision:** `ShellExecuteExW(Verb="runas")` is wrapped inside the native addon, which calls `CoInitializeEx` before and `CoUninitialize` after. This satisfies the COM init requirement from MSDN.

**Consequences:** UAC elevation works reliably from the TUI and MCP on Windows.

## DEC-021 — Native addon is required on Windows for capture

**Decision:** On Windows, the native addon (`haril_native.node`) is required for capture functionality (ETW + USN journal + FSW callbacks). Without it, the TUI `start-capture` command returns an error and no live capture is possible. However, opening and analyzing existing `.haril` packages still works — the TUI enters analyze phase with a summary indicating the addon is missing.

On non-Windows hosts (macOS, Linux), the native addon is not built and the project degrades fully: no capture (those OSes don't have NTFS/ETW/USN in the same way), but `.haril` analysis packages opened from Windows can be inspected, searched, and summarized.

**Consequences:** The project is cross-platform for analysis-only use cases, but Windows capture always requires the native addon.

## DEC-022 — Single-file executable per RID via `bun build --compile`

**Decision:** Build one explicitly named executable per Windows architecture:
`bun build --compile --target=bun-windows-x64 --outfile=dist/haril-x64.exe`
and `bun build --compile --target=bun-windows-arm64
--outfile=dist/haril-arm64.exe`.

**Consequences:** Each standalone executable runs natively on its target
architecture without requiring Bun. The architecture suffix prevents users
from accidentally running the x64 build under Windows ARM64 emulation.

## DEC-023 — Bun-only runtime (not Node-compatible) at development time

**Decision:** The project uses `bun:sqlite` for all persistence. The test suite and build scripts assume Bun. A Node-published binary would need `better-sqlite3` instead of `bun:sqlite`.

**Consequences:** Development, testing, and CI all run under Bun. The published Windows binary bundles JS via Bun's compiler.

## DEC-024 — Native DLL compiled with MSVC + MSBuild

**Context:** Cross-compilation with Zig 0.16 on Windows-arm64 hosts crashes with ACCESS_VIOLATION when trying to compile real C++ for x64. Visual Studio 2022 Build Tools with MSVC v14.44 is available and works.

**Decision:** The native addon is built with `msbuild.exe` from a `.vcxproj` project targeting `x64` and `v143`. The C++ source uses C++20 + selected C++23 features (`std::jthread`, `std::span`, RAII). MSBuild targets `<LanguageStandard>stdcpplatest</LanguageStandard>`.

**Consequences:** The native library was verified end-to-end on this host with a `LoadLibraryW` smoke test and calls to its exported functions.

## DEC-025 — Modern C++ style in the native addon

**Decision:** No raw `new`/`delete` in the C++ body (only at the C-export boundary). `UniqueHandle` for every Win32 HANDLE. `RingBuffer` owns its `VirtualAlloc` memory. `std::jthread` joins on `HarilContext` destruction. `std::atomic<bool>` stop flags for the ETW consumer thread.

**Consequences:** Memory safety. No handle leaks. Reliable thread shutdown.

## DEC-025B — Lock-Free MPSC Ring Buffer for Kernel Event Streaming

**Context:** The capture pipeline receives events from two independent native threads: the kernel ETW callback (`EtwEventCallback`, which runs at dispatch/kernel context and must never be blocked) and the NTFS USN journal polling thread (`usn_thread_entry`). Synchronizing these threads with a conventional mutex caused priority inversion and contention, leading to ETW buffer overruns (`EventsLost`) under heavy file I/O workloads.

**Decision:** Replace the mutex-protected queue with an in-memory lock-free
MPSC ring buffer inspired by the Disruptor pattern:
- Pre-allocated 64 MiB buffer (65,536 slots of 1,024 bytes) via Win32 `VirtualAlloc`.
- Atomic sequence claiming using `fetch_add` on `head_seq_`.
- Slot publication barriers using an atomic sequence array (`available_`) with release semantics.
- Batched zero-lock consumption in `pop_batch` tracking contiguous published sequences.

**Consequences:** Complete elimination of lock contention. Zero kernel-callback stalls. Maximized event throughput and fidelity under heavy disk stress.

## DEC-026 — ZIP writer in-tree (STORE)

**Decision:** A compact in-tree ZIP writer/reader (~120 lines). JSONL streams are already compact; the manifest SHA-256 protects integrity.

**Consequences:** No external ZIP dependency. The package writer is auditable and small.

## DEC-027 — Native addon loads via `require()`

**Context:** Native capture functionality is exposed to TypeScript through a Node-API addon.

**Decision:** Ship the native core as a Node-API addon (`haril_native.node`, `NAPI_MODULE_INIT`) and load it with plain `require()`, exactly like other per-platform binaries. `packages/core/src/ffi/bindings.ts` resolves the file platform-aware (`bin` for x64, `bin-arm64` for arm64) and returns `null` when it cannot load, preserving analyze-only degradation. `node.lib` (per arch, from `nodejs.org/dist`) is linked at build time; it is downloaded by `build-windows.ps1` and gitignored.

**Consequences:** The addon loads reliably via `require()` across Bun and Node environments. The project degrades gracefully when the addon is unavailable.

## DEC-029 — ETW session uses the canonical `NT Kernel Logger` name

**Context:** `StartTraceW` with `SystemTraceControlGuid` and a custom session name fails with `ERROR_INVALID_PARAMETER` (87) on this Windows build (verified empirically: custom name → 87 in all flag combinations; canonical `NT Kernel Logger` name → 5 without elevation, i.e. params valid).

**Decision:** `etw_start` ignores the caller-provided name and always starts (or attaches to) the canonical session. If another tool already owns the session (`ERROR_ALREADY_EXISTS`), we attach as a consumer and never stop a session we did not start (`etwOwnsSession` flag).

**Consequences:** Capture always works without needing to name the session. No "session name invalid" errors. If another tool has the session, we simply attach as a consumer.

## DEC-030 — USN journal identity rides in the slot extension block

**Context:** USN records need FRN identity that ETW slots do not carry.

**Decision:** The USN producer writes `fileReferenceNumber`, `parentFileReferenceNumber`, `usn` (u64 each) and `reason` (u32) at slot offsets `[176..204]`. The TS decoder exposes them as `DecodedSlot.usn`. Capture persists them into `usn-events.jsonl`.

**Consequences:** USN records carry enough identity information to track files across renames and moves, and their FRN-based `fileId128` matches the inventory identity.

## DEC-049 — USN records carry the lifecycle kind decoded from their reason

**Context:** The USN producer emitted every journal record with a fixed `Notify` kind while storing the `reason` bitmask in the slot extension. A measured 6-second capture produced 114 USN events, all `Notify`, covering no path that ETW had not already reported: roughly 29% of the timeline was semantically empty duplication, even though the producer had already decoded the reason that explains each record.

**Decision:** `usn_reason_to_kind()` maps the accumulated reason bitmask onto a single `EventKind` at encode time, most decisive outcome first (`Delete` > `Create` > `Rename` > `Write` > `SetInfo` > `Close` > `Notify`). The producer stays the single source of truth for `kind`; the full bitmask remains in the slot extension and in `usn_records` for consumers that need the detail.

**Consequences:** Journal events describe what happened instead of merely that something happened, so they act as a semantic safety net when ETW drops events (`eventsLost`). The same measured workload now yields `Create`, `Write`, `Rename` and `Delete` kinds and no `Notify`. Because a record accumulates reasons until close, one file change can surface as several records sharing the same kind — the journal's own granularity, not a duplication introduced here.

## DEC-031 — Single QPC clock domain per package

**Context:** Native event slots carry QPC nanoseconds; JS `hrtime` is a different monotonic clock. Mixing them breaks timeline ordering.

**Decision:** A `nowNs` N-API export exposes the QPC clock to TS. When the addon is present, manifest window, inventory `observedAt`, FSW notification timestamps and synthesized diff events all use it. In TS-only mode everything uses `process.hrtime`. The two domains are never mixed inside one package.

**Consequences:** Timeline ordering is consistent whether the addon is present or not. The two clock domains are isolated.

## DEC-032 — `start-capture` runs the window, then opens the result

**Context:** The project runs the capture window, writes the package, imports it, and lands in the analyze phase with a summary including per-source availability and start return codes. The live-capture phase and stop-capture remain as markers for future interactive mode.

**Decision:** `start-capture --root --output --seconds` runs `runCapture` (native ETW/USN best-effort + FSW + inventories), writes the package, imports it and lands in the analyze phase with a summary including per-source availability and start return codes. The `live-capture` phase and `stop-capture` remain as markers for the future interactive mode.

**Consequences:** MVP captures synchronously, writes a package, and immediately opens analysis. The interactive live-capture UI is deferred to a future release.

## DEC-033 — Embedded native addon for single-file standalone distribution

**Context:** Distributing the standalone executable previously required distributing `haril_native.node` alongside it. Win32 `LoadLibraryW` requires a physical file path on disk, preventing direct in-memory DLL execution. However, users expect a single-file download without loose DLL dependencies.

**Decision:** Implement an embed-and-extract standalone distribution mode (`bun run build:standalone`):
- `scripts/embed-native.ts` embeds the compiled native `.node` binary as a base64 payload inside `packages/core/src/ffi/embedded_addon.ts`.
- `bun build --compile` packages Bun, JS, dependencies, and the embedded
  payload into architecture-specific `dist/haril-x64.exe` and
  `dist/haril-arm64.exe` files.
- At runtime on Windows, `ensureExtractedNative()` extracts the payload to `%LOCALAPPDATA%/Haril/bin/<arch>/haril_native.node` (or `%TEMP%/haril-bin/` fallback) on first use, caching and reusing it if matching.
- UAC elevation (`ShellExecuteExW("runas")`) seamlessly shares the extracted addon in `%LOCALAPPDATA%/Haril/bin/`.
- Multi-file portable layout (executable + `haril_native.node` next to each
  other) and developer layout continue to work with higher priority if present.

**Consequences:** Users select the executable matching their Windows
architecture and can run it without sacrificing kernel ETW and USN capture
capabilities or requiring manual extraction. The npm package remains one
cross-architecture JavaScript artifact because its Node.js or Bun host process
selects the matching embedded addon through `process.arch`.

---
*All decisions above are self-contained for this project. No prior knowledge of other tools or the original Haril project is required.*
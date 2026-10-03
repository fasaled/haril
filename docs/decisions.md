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

**Context:** `TdhGetEventInformation` fails with `ERROR_NOT_FOUND` (1168) for kernel-mode events. The schema-driven TDH path does not carry the observed path as a generic string — it depends on MOF definitions that may not be installed. An empirical survey discovered that the layout of offsets in the ETW callback is consistent across event types.

**Decision:** Implement a manual parser of fixed offsets in the ETW consumer callback. The layout offsets are: [0..8)=FileObject, [8..16)=IrpPtr, [16..20)=createOptions, [20..24)=createDisposition, [24..28)=shareAccess, [32..)=FileName (UTF-16 NUL-terminado). The `map_kind()` function maps opcode values to event kinds for both the Manifest provider and the MOF Kernel FileIo provider (Data1=0x90CBDC39).

**Consequences:**
- The ETW callback is stable: exit code 0 (previously -1073741819).
- `map_kind()` handles both providers: Manifest (Data1=0xBCC65049) and MOF Kernel FileIo (Data1=0x90CBDC39).
- No dependency on Windows MOF schemas that change between updates.
- The same offset layout carries USN identity fields at slots [176..204].

## DEC-019 — `ShellExecuteExW` requires COM init

**Decision:** `ShellExecuteExW(Verb="runas")` is wrapped inside the native addon, which calls `CoInitializeEx` before and `CoUninitialize` after. This satisfies the COM init requirement from MSDN.

**Consequences:** UAC elevation works reliably from the TUI and MCP on Windows.

## DEC-021 — Native addon is required on Windows for capture

**Decision:** On Windows, the native addon (`haril_native.node`) is required for capture functionality (ETW + USN journal + FSW callbacks). Without it, the TUI `start-capture` command returns an error and no live capture is possible. However, opening and analyzing existing `.haril` packages still works — the TUI enters analyze phase with a summary indicating the addon is missing.

On non-Windows hosts (macOS, Linux), the native addon is not built and the project degrades fully: no capture (those OSes don't have NTFS/ETW/USN in the same way), but `.haril` analysis packages opened from Windows can be inspected, searched, and summarized.

**Consequences:** The project is cross-platform for analysis-only use cases, but Windows capture always requires the native addon.

## DEC-022 — Single-file executable per RID via `bun build --compile`

**Decision:** `bun build --compile --target=bun-windows-x64 --outfile=dist/haril.exe`. The native DLL sits next to the executable.

**Consequences:** A standalone `haril.exe` that can be distributed and run without requiring Bun to be installed (it embeds the runtime). The native addon `.node` file must be present alongside the `.exe` for capture to work.

## DEC-023 — Bun-only runtime (not Node-compatible) at development time

**Decision:** The project uses `bun:sqlite` for all persistence. The test suite and build scripts assume Bun. A Node-published binary would need `better-sqlite3` instead of `bun:sqlite`, and the FFI path would differ.

**Consequences:** Development, testing, and CI all run under Bun. The published Windows binary bundles JS via Bun's compiler.

## DEC-024 — Native DLL compiled with MSVC + MSBuild

**Context:** Cross-compilation with Zig 0.16 on Windows-arm64 hosts crashes with ACCESS_VIOLATION when trying to compile real C++ for x64. Visual Studio 2022 Build Tools with MSVC v14.44 is available and works.

**Decision:** The native addon is built with `msbuild.exe` from a `.vcxproj` project targeting `x64` and `v143`. The C++ source uses C++20 + selected C++23 features (`std::jthread`, `std::span`, RAII). MSBuild targets `<LanguageStandard>stdcpplatest</LanguageStandard>`.

**Consequences:** The DLL is verified end-to-end on this host: a separate smoke test that calls `LoadLibraryW("haril_native.dll")` followed by the exported functions runs successfully. The DLL can be loaded by any Windows runtime (including Bun with `bun:ffi.dlopen` enabled, Node with `node-ffi-napi`, etc.). On this Bun 1.3.14 build (TinyCC disabled), `bun:ffi.dlopen` fails to load the DLL; the runtime degrades gracefully to analyze-only.

## DEC-025 — Modern C++ style in the native addon

**Decision:** No raw `new`/`delete` in the C++ body (only at the C-export boundary). `UniqueHandle` for every Win32 HANDLE. `RingBuffer` owns its `VirtualAlloc` memory. `std::jthread` joins on `HarilContext` destruction. `std::atomic<bool>` stop flags for the ETW consumer thread.

**Consequences:** Memory safety. No handle leaks. Reliable thread shutdown.

## DEC-026 — ZIP writer in-tree (STORE)

**Decision:** A compact in-tree ZIP writer/reader (~120 lines). JSONL streams are already compact; the manifest SHA-256 protects integrity.

**Consequences:** No external ZIP dependency. The package writer is auditable and small.

## DEC-027 — Native addon loads via `require()`, not `bun:ffi`

**Context:** `bun:ffi.dlopen()` reports "TinyCC is disabled" on Bun 1.3.14 here, so the FFI path can never work in this environment. A direct `LoadLibraryW` smoke test of the DLL succeeds, proving the native code itself is sound.

**Decision:** Ship the native core as a Node-API addon (`haril_native.node`, `NAPI_MODULE_INIT`) and load it with plain `require()`, exactly like other per-platform binaries. `packages/core/src/ffi/bindings.ts` resolves the file platform-aware (`bin` for x64, `bin-arm64` for arm64) and returns `null` when it cannot load, preserving analyze-only degradation. `node.lib` (per arch, from `nodejs.org/dist`) is linked at build time; it is downloaded by `build-windows.ps1` and gitignored.

**Consequences:** The addon loads reliably via `require()` across Bun and Node environments. The project degrades gracefully when the addon is unavailable.

## DEC-029 — ETW session uses the canonical `NT Kernel Logger` name

**Context:** `StartTraceW` with `SystemTraceControlGuid` and a custom session name fails with `ERROR_INVALID_PARAMETER` (87) on this Windows build (verified empirically: custom name → 87 in all flag combinations; canonical `NT Kernel Logger` name → 5 without elevation, i.e. params valid).

**Decision:** `etw_start` ignores the caller-provided name and always starts (or attaches to) the canonical session. If another tool already owns the session (`ERROR_ALREADY_EXISTS`), we attach as a consumer and never stop a session we did not start (`etwOwnsSession` flag).

**Consequences:** Capture always works without needing to name the session. No "session name invalid" errors. If another tool has the session, we simply attach as a consumer.

## DEC-030 — USN journal identity rides in the slot extension block

**Context:** The 256-byte slot has 80 reserved bytes. USN records need FRN identity that ETW slots do not carry.

**Decision:** The USN producer writes `fileReferenceNumber`, `parentFileReferenceNumber`, `usn` (u64 each) and `reason` (u32) at slot offsets `[176..204]`. The TS decoder exposes them as `DecodedSlot.usn`. Capture persists them into `usn-events.jsonl`.

**Consequences:** USN records carry enough identity information to track files across renames and moves, within the constraints of the 256-byte slot.

## DEC-031 — Single QPC clock domain per package

**Context:** Native event slots carry QPC nanoseconds; JS `hrtime` is a different monotonic clock. Mixing them breaks timeline ordering.

**Decision:** A `nowNs` N-API export exposes the QPC clock to TS. When the addon is present, manifest window, inventory `observedAt`, FSW notification timestamps and synthesized diff events all use it. In TS-only mode everything uses `process.hrtime`. The two domains are never mixed inside one package.

**Consequences:** Timeline ordering is consistent whether the addon is present or not. The two clock domains are isolated.

## DEC-032 — `start-capture` runs the window, then opens the result

**Context:** The project runs the capture window, writes the package, imports it, and lands in the analyze phase with a summary including per-source availability and start return codes. The live-capture phase and stop-capture remain as markers for future interactive mode.

**Decision:** `start-capture --root --output --seconds` runs `runCapture` (native ETW/USN best-effort + FSW + inventories), writes the package, imports it and lands in the analyze phase with a summary including per-source availability and start return codes. The `live-capture` phase and `stop-capture` remain as markers for the future interactive mode.

**Consequences:** MVP captures synchronously, writes a package, and immediately opens analysis. The interactive live-capture UI is deferred to a future release.

---
*All decisions above are self-contained for this project. No prior knowledge of other tools or the original Haril project is required.*
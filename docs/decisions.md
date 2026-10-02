# Haril-TS — Decisions

Architecture decisions, in the format `Context / Decision / Consequences`.

## DEC-001 — Workspace Bun `packages/core` (private) + `packages/cli` (public)

**Decision:** `packages/core` is a private workspace member exporting
`@haril-ts/core`. `packages/cli` is the public package
(`@haril-ts/cli`, binary `haril`).

## DEC-002 — Single command core; TUI and MCP are thin adapters

**Decision:** `FileTimelineCommands` is the single product-level query
service. TUI and MCP both call into it.

## DEC-003 — Shebang `#!/usr/bin/env node` (Bun for dev)

The published bin runs under Bun (1.3+) or Node (20+). `bun:sqlite`
is Bun-only; for Node runtimes we'd need `better-sqlite3`. **We
target Bun only.**

## DEC-006 — Ink 7.1.1 + React 19.3.0 (not Solid, not OpenTUI)

Style is aligned with `fasaled/muin` and `fasaled/sailkari`.

## DEC-007 — No `haril capture` or `haril analyze` CLI

`start-capture` is a TUI command (DEC-048 of the original Haril).

## DEC-008 — Auto-relaunch via `ShellExecuteExW(Verb="runas")`

Runas + COM init + CoUninitialize wrapped in
`haril_relaunch_elevated` (native) / called from `writePendingSession`
(TS). Pre-staged in `%LOCALAPPDATA%/Haril/pending-session.json`.

## DEC-010 — Command prompt always visible with vertical completion menu

DEC-050/052 of the original Haril.

## DEC-011 — Activity panel replaces command overlay

DEC-051 of the original Haril.

## DEC-012 — In-process command queue

DEC-054 of the original Haril.

## DEC-013 — Heuristic DEC-035

Off by default, labelled `[inferred]`, computed in memory only,
never written to the package. Two rules implemented:
`delete → recreate` and `temporary-file → target replacement`.

## DEC-015 — Windows-only, NTFS-only

## DEC-017 — Native DLL via `TdhGetEventInformation`

Microsoft's official TDH API. Schemas cached by
`(ProviderGuid, EventDescriptor.Id, EventDescriptor.Version)`. Per-property
extraction uses `TdhFormatProperty`.

## DEC-018 — `Sechost.lib` is not linked

Although MSDN says `ProcessTrace` lives there on Win 8.1+, the import
library is not bundled in the SDK. Linking via `Advapi32` works.

## DEC-019 — `ShellExecuteExW` requires COM init

Wrapped in `haril_relaunch_elevated` inside the native DLL.

## DEC-021 — Native DLL is optional at runtime

**Context:** Some Bun builds disable `bun:ffi.dlopen()` (`TinyCC
disabled`). The DLL cannot be loaded in those environments even if
it is present.

**Decision:** `bindings.ts` returns `null` if the DLL is missing or
`bun:ffi.dlopen()` throws. `requireNative()` raises a structured
error explaining how to build. TUI/MCP can still open existing
`.haril` packages and run analysis without the DLL.

## DEC-022 — Single-file executable per RID via `bun build --compile`

`bun build --compile --target=bun-windows-x64 --outfile=dist/haril.exe`.
The native DLL sits next to the executable.

## DEC-023 — Bun-only runtime (not Node-compatible)

## DEC-024 — Native DLL compiled with MSVC + MSBuild

**Context:** Zig 0.16.0 (aarch64) installed on Windows-arm64 hosts
crashes with ACCESS_VIOLATION when cross-compiling real C++ for
`x86_64-windows-msvc`. Visual Studio 2022 Build Tools with MSVC
v14.44 is installed locally and works.

**Decision:** Native DLL is built with `msbuild.exe` from a
`.vcxproj` project targeting `x64` and `v143`. The build script
`native/build-windows.ps1` resolves `MSBuild.exe` via `vswhere.exe`.

The C++ source uses C++20 + selected C++23 features
(`std::jthread`, `std::span`, RAII). MSBuild targets
`<LanguageStandard>stdcpplatest</LanguageStandard>`.

**Consequences:**

- The DLL is verified end-to-end on this host: a separate `smoke.exe`
  that calls `LoadLibraryW("haril_native.dll")` followed by
  `haril_open` / `haril_is_admin` / `haril_close` runs successfully.
- The DLL can be loaded by any Windows runtime (including Bun with
  `bun:ffi.dlopen` enabled, Node with `node-ffi-napi`, etc.).
- On this Bun 1.3.14 build (TinyCC disabled), `bun:ffi.dlopen`
  fails to load the DLL; the runtime gracefully degrades to
  analyze-only.

## DEC-025 — Modern C++ style in native code

No raw `new`/`delete` in the C++ body (except at the C-export
boundary). `UniqueHandle` for every Win32 HANDLE. `RingBuffer`
owns its `VirtualAlloc` memory. `std::jthread` joins on
`HarilContext` destruction. `std::atomic<bool>` stop flags for
the ETW consumer thread.

## DEC-026 — ZIP writer in-tree (STORE)

~120 line ZIP writer/reader. JSONL streams are already compact; the
manifest SHA-256 protects integrity.

## DEC-027 — Native addon loads via `require()`, not `bun:ffi`

**Context:** `bun:ffi.dlopen()` reports `TinyCC is disabled` on Bun
1.3.14 here, so the FFI path can never work in this environment.
A direct `LoadLibraryW` smoke test of the DLL succeeds, proving the
native code itself is sound.

**Decision:** Ship the native core as a Node-API addon
(`haril_native.node`, `NAPI_MODULE_INIT`) and load it with plain
`require()`, exactly like `@opentui/core` does with its
per-platform binaries. `packages/core/src/ffi/bindings.ts` resolves
the file platform-aware (`bin` for x64, `bin-arm64` for arm64) and
returns `null` when it cannot load, preserving analyze-only
degradation. `node.lib` (per arch, from `nodejs.org/dist`) is linked
at build time; it is downloaded by `build-windows.ps1` and gitignored.

## DEC-028 — Heuristic view (DEC-035) implemented in pure TypeScript

`packages/core/src/model/heuristic.ts` exposes
`computeHeuristicBridges` and `mergedLaneEvents` as pure functions.
The TUI/MCP can request the heuristic view via
`browseHeuristicFileTimelines` and `inspectHeuristicFileTimeline`.
The bridges are labelled `InferredRecreation` (delete→create on the
same path within 1000 ms) or `InferredAtomicReplacement`
(temporary-file → target rename within 1000 ms).
## DEC-029 — Kernel capture uses the canonical `NT Kernel Logger` name

**Context:** `StartTraceW` with `SystemTraceControlGuid` and a custom
session name fails with `ERROR_INVALID_PARAMETER` (87) on this Windows
build (verified empirically: custom name → 87 in all flag combinations;
canonical `NT Kernel Logger` name → 5 without elevation, i.e. params valid).

**Decision:** `etw_start` ignores the caller-provided name and always
starts (or attaches to) the canonical session. If another tool already
owns it (`ERROR_ALREADY_EXISTS`), we attach as a consumer and never
stop a session we did not start (`etwOwnsSession` flag).

## DEC-030 — USN journal identity rides in the slot extension block

**Context:** The 256-byte slot has 80 reserved bytes. USN records need
FRN identity that ETW slots do not carry.

**Decision:** The USN producer writes `fileReferenceNumber`,
`parentFileReferenceNumber`, `usn` (u64 each) and `reason` (u32) at
slot offsets `[176..204]`. The TS decoder exposes them as
`DecodedSlot.usn`; capture persists them into `usn-events.jsonl`.

## DEC-031 — Single QPC clock domain per package

**Context:** Native event slots carry QPC nanoseconds; JS `hrtime` is a
different monotonic clock. Mixing them breaks timeline ordering.

**Decision:** A `nowNs` N-API export exposes the QPC clock to TS. When
the addon is present, manifest window, inventory `observedAt`, FSW
notification timestamps and synthesized diff events all use it. In
TS-only mode everything uses `process.hrtime`. The two domains are
never mixed inside one package.

## DEC-032 — `start-capture` runs the window, then opens the result

**Context:** The original product has an interactive live-capture phase
with a live index. Our MVP runs the capture window synchronously.

**Decision:** `start-capture --root --output --seconds` runs
`runCapture` (native ETW/USN best-effort + FSW + inventories), writes
the package, imports it and lands in the analyze phase with a summary
including per-source availability and start return codes. The
`live-capture` phase and `stop-capture` remain as markers for the
future interactive mode.

# haril_native — Node-API addon build

Haril-TS captures kernel ETW events, USN journal records, and per-file identities through a Node-API addon: `haril_native.node`. The TypeScript side loads it via `require()`.

## Node-API addon

The addon is **required on Windows** for capture functionality (ETW + USN journal + FSW callbacks). Without it, the TUI `start-capture` command returns an error and no live capture is possible. However, opening and analyzing existing `.haril` packages still works — the TUI enters analyze phase with a summary indicating the addon is missing.

On non-Windows hosts (macOS, Linux), the native addon is not built and the project degrades fully: no capture (those OSes don't have NTFS/ETW/USN in the same way), but `.haril` analysis packages opened from Windows can be inspected, searched, and summarized.

This keeps the project cross-platform for analysis-only use cases while ensuring Windows capture always requires the native addin.

### ARM64 support

The build script supports both architectures:

```powershell
bun run build:native            # x64 Release (default)
bun run build:native:arm64      # arm64 Release
```

The output mirrors by architecture:
- `haril_native.node` (x64, default)
- `haril_native.node` (arm64, after `build:native:arm64`)

On ARM64 Windows hosts, you must build/select the arm64 `.node` file. An x64 `.node` cannot load into an arm64 process (`LoadLibrary` fails with `%1 is not a valid Win32 application`). Conversely, on x64 Windows the x64 `.node` is required.

The current build output contains the x64 build. To build for arm64, run `bun run build:native:arm64` on an arm64 host or via cross-compilation setup.

## Toolchain

We use **MSBuild** with **Visual Studio 2022 C++ Build Tools** (`MSBuild.exe` + `cl.exe` + `link.exe`) targeting **MSVC v143** and the **Windows 10/11 SDK** (10.0.26100.0 in this build).

`build-windows.ps1` wraps the call:

```powershell
bun run build:native            # x64 Release (default)
bun run build:native:arm64      # arm64 Release
```

The output is `haril_native.node` (`bin-arm64` for arm64).

The C++ source is C++20 with selected C++23 features (`std::jthread`, `std::span`). MSBuild targets `<LanguageStandard>stdcpplatest</LanguageStandard>`.


### Addon loading

The native core is shipped as a Node-API addon (`haril_native.node`, `NAPI_MODULE_INIT`) and loaded with plain `require()`. `packages/core/src/ffi/bindings.ts` resolves the file platform-aware (`bin` for x64, `bin-arm64` for arm64) and returns `null` when it cannot load, preserving analyze-only degradation. `node.lib` (per arch, from `nodejs.org/dist`) is linked at build time; it is downloaded by `build-windows.ps1` and gitignored.

## C++ style guide (modern, RAII-first)

- **No raw `new`/`delete`** in the C++ body. The addon uses a class constructed only at the C-export boundary (`napi_addon.cpp`); everything else is `std::unique_ptr`, `std::jthread`, `std::span`, `std::string_view`.
- **No leaked handles**: `UniqueHandle = std::unique_ptr<void, HandleDeleter>` for every `HANDLE`. `CloseHandle` runs in the deleter.
- **`RingBuffer`** owns its `VirtualAlloc`-backed memory; the destructor calls `VirtualFree`.
- **RAII for ETW/USN threads** via `std::jthread`: on `HarilContext` destruction we explicitly request stop and join. On any other path (errors, exception), the `std::jthread` joins in its own destructor.
- **`std::atomic<bool>` flags** for stop signalling from the producer to the ETW consumer thread (more reliable than `stop_token` here because we don't pass `stop_token` through `std::jthread` constructors in this MSVC version).

### Standalone Distribution (Single-File Binary)

To distribute a single self-contained `haril.exe` without requiring a loose `haril_native.node` file alongside it:

```powershell
bun run build:standalone
```

This executes:
1. `bun run scripts/embed-native.ts`: Reads the compiled native addon from `native/out/bin/` and embeds it as a payload inside `packages/core/src/ffi/embedded_addon.ts`.
2. `bun build packages/cli/src/cli.ts --compile --outfile dist/haril.exe`: Generates a single executable containing the Bun runtime, UI, SQLite engine, and the embedded native addon.

At runtime on Windows, `bindings.ts` automatically extracts the addon to `%LOCALAPPDATA%/Haril/bin/<arch>/haril_native.node` on first use.

## Layout

```
haril_native/
├── haril_native.vcxproj       MSBuild project
├── build-windows.ps1           invokes MSBuild + vswhere
├── include/haril_native.h      public C API (opaque Pimpl)
├── src/main.cpp                 DllMain + napi_addon.cpp with 18 exports
├── src/core.cpp                 HarilContext::Impl, ETW/USN/inventory/elevation
├── src/napi_addon.cpp           18 exports N-API, atomic_counter_js wrappers
└── out/bin/haril_native.node       (build output; mirrored as .dll for smoke tests)
```

## Public C API (opaque Pimpl)

The addon exports 18 N-API functions wrapped in `napi_addon.cpp`. The public header `haril_native.h` declares them as `napi_callback_value` patterns; the actual C++ implementations live in `core.cpp`. Key exports:

| Export | Description |
|---|---|
| `haril_open()` | Creates `HarilContext` with RAII handles, starts nothing |
| `haril_close()` | Destroys `HarilContext`, joins threads, frees memory |
| `haril_source_status()` | Return bitmask: ETW/USN/FSW available |
| `haril_etw_start()` | ETW session: canonical `NT Kernel Logger`, attach or start |
| `haril_etw_stop()` | Request stop to ETW consumer thread |
| `haril_etw_events_observed()` | Return observed event count |
| `haril_etw_buffers_written()` | Return buffers written count |
| `haril_etw_events_lost()` | Return lost event count |
| `haril_etw_candidates_out_of_scope()` | Return out-of-root events |
| `haril_usn_start()` | USN journal thread: `FSCTL_READ_USN_JOURNAL` |
| `haril_usn_stop()` | Request stop to USN thread |
| `haril_usn_records_read()` | Return total records read |
| `haril_inventory_walk()` | Walk directory tree, emit `FILE_ID_INFO` |
| `haril_get_file_id()` | Extract volume serial + FILE_ID_INFO from path |
| `haril_is_admin()` | Check if running elevated (`CheckTokenMembership`) |
| `haril_relaunch_elevated()` | `ShellExecuteExW(Verb="runas")` with COM init |
| `haril_drain()` | Drain whole ring records into a buffer (1,024-byte slots) |

Strings are UTF-16LE with explicit length because N-API does not auto-convert UTF-8 to UTF-16LE; the `napi_addon.cpp` wrapper converts JS strings on the way in.

## Disruptor Ring Buffer Engine (Lock-Free MPSC)

The ring buffer implements the LMAX Disruptor pattern for Multi-Producer Single-Consumer (MPSC) concurrency without locks:
- Pre-allocated 64 MiB ring storage (65,536 slots × 1,024 bytes) via Win32 `VirtualAlloc`.
- Whole-record claiming via CAS on `head_seq_` (head + continuation slots; nothing is claimed when the record does not fit).
- Publication flags (`available_`) per slot updated with `std::memory_order_release`.
- Batch consumer reading up to contiguous published sequences, updating `tail_seq_`.
- Guarantees zero-lock dispatching from the Windows Kernel ETW callback thread, completely eliminating priority inversion and mutex stalls.

## Slot layout (1,024 bytes, little-endian)

A record is a head slot followed by `extraSlots` continuation slots (raw UTF-16LE, 512 units each). Paths longer than the 384 units stored inline continue there, up to 32,767 units (`HARIL_MAX_RECORD_SLOTS` = 65). `drain(ctx, maxSlots)` always returns whole records.

| Offset | Size | Field |
|---|---|---|
| 0   | 2   | source (1=ETW, 2=USN, 3=FSW) |
| 2   | 2   | EventKind (1=Create 2=Open 3=Read 4=SetInfo 5=Write 6=Close 7=Rename 8=Delete 9=OpEnd 10=Notify) |
| 4   | 8   | timestamp_ns |
| 12  | 4   | pid |
| 16  | 4   | tid |
| 20  | 8   | IrpPtr (or 0) |
| 28  | 4   | ntStatus (or 0) |
| 32  | 16  | fileId128 |
| 48  | 4   | volumeSerial |
| 52  | 4   | byteOffset (low 32 bits) |
| 56  | 4   | byteLength |
| 60  | 4   | shareAccess |
| 64  | 4   | createOptions |
| 68  | 4   | createDisposition |
| 72  | 4   | sourceEventIndex |
| 76  | 2   | observedPath length (UTF-16 units, total) |
| 78  | 2   | processImageName length |
| 80  | 2   | extraSlots (continuation slots that follow) |
| 112 | 64  | processImageName (UTF-16LE, 32 units) |
| 176 | 8   | USN only: fileReferenceNumber (u64) |
| 184 | 8   | USN only: parentFileReferenceNumber (u64) |
| 192 | 8   | USN only: usn (u64) |
| 200 | 4   | USN only: reason flags (u32) |
| 256 | 768 | observedPath, first 384 units (UTF-16LE) |

The addon exports `slotSize`; the TS loader rejects an addon whose `slotSize` differs from `NATIVE_SLOT_SIZE`, so a stale extracted addon is never decoded with the wrong layout.
## ETW session naming

The NT Kernel Logger only accepts its canonical session name (`NT Kernel Logger`); a custom name makes `StartTraceW` fail with `ERROR_INVALID_PARAMETER` (87). `etw_start` therefore always starts (or attaches to) the canonical session regardless of the name passed in. If another tool already owns the session (`ERROR_ALREADY_EXISTS`), we attach as a consumer and never stop a session we did not start (`etwOwnsSession` flag).

## USN journal identity in slot [176..204]

USN records need FRN identity that ETW slots do not carry. The USN producer writes `fileReferenceNumber`, `parentFileReferenceNumber`, `usn` (u64 each) and `reason` (u32) at slot offsets `[176..204]`, and the FRN zero-extended as `fileId128` with the root's volume serial (matching inventory keys). The TS decoder exposes them as `DecodedSlot.usn`.
## UAC scenario (confirmed end-to-end)

After build, the following is verified:
- `LoadLibraryW(L"haril_native.dll")` / `LoadLibraryW(L"haril_native.node")` succeeds.
- `GetProcAddress(lib, "haril_open")` returns a valid function pointer.
- `haril_open()` returns a non-null handle.
- `haril_is_admin()` returns 0 (not elevated) or 1 (elevated).
- `haril_close(handle)` does not crash.
- `haril_relaunch_elevated()` elevates a new console window with `runas`.

## Graceful degradation

If the addon cannot be loaded (TinyCC disabled, wrong architecture, missing `node.lib` at link time), `bindings.ts` returns `null` and the runtime degrades to "analyze only": opening `.haril` packages works; starting capture returns a corrective error.

This is the situation on this build host (Bun 1.3.14 with TinyCC disabled). The DLL itself is verified working through a direct `LoadLibraryW` smoke test. On a Bun build with TinyCC enabled, the addon loads via `require()` and the full capture path becomes exercisable from the TUI.

## Building the addon

```bash
bun install           # workspace install
bun run build:native  # x64 Release (default) or arm64
bun test              # unit + integration tests
bun run typecheck     # tsc --noEmit
```

The build script `build-windows.ps1` resolves `MSBuild.exe` via `vswhere.exe`, invokes `haril_native.vcxproj` targeting `x64` / `Release` / `stdcpplatest`, and outputs `haril_native.node`. `node.lib` is downloaded from `nodejs.org/dist` if not present; it is gitignored.

## Verifying the addon

```bash
# Load and smoke-test from JS
node -e "const m = require('./haril_native.node'); console.log(Object.keys(m).length, 'exports loaded')"

# From Bun
bun -e "const m = require('./haril_native.node'); console.log(Object.keys(m).length, 'exports loaded')"
```

On ARM64 hosts, the x64 `.node` cannot load into an arm64 process: validate with an x64 runtime process.

---
*This documentation is self-contained. No prior knowledge of other projects is required.*
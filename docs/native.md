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

We use **MSBuild** with **Visual Studio 2022 C++ Build Tools** (`MSBuild.exe` + `cl.exe` + `link.exe`) targeting **MSVC v143** and the latest installed **Windows 10/11 SDK**.

`build-windows.ps1` wraps the call:

```powershell
bun run build:native            # x64 Release (default)
bun run build:native:arm64      # arm64 Release
```

The output is `haril_native.node` (`bin-arm64` for arm64).

The C++ source is C++20 with selected C++23 features (`std::jthread`, `std::span`). MSBuild targets `<LanguageStandard>stdcpplatest</LanguageStandard>`.


### Addon loading

The native core is shipped as a Node-API addon (`haril_native.node`, `NAPI_MODULE_INIT`) and loaded with plain `require()`. `packages/core/src/ffi/bindings.ts` resolves the file platform-aware (`bin` for x64, `bin-arm64` for arm64) and returns `null` when it cannot load, preserving analyze-only degradation. N-API entry points are resolved dynamically, so no vendored `node.lib` import
library is required. Headers come from the locked `node-api-headers`
development dependency.

## C++ style guide (modern, RAII-first)

- **No raw `new`/`delete`** in the C++ body. The addon uses a class constructed only at the C-export boundary (`napi_addon.cpp`); everything else is `std::unique_ptr`, `std::jthread`, `std::span`, `std::string_view`.
- **No leaked handles**: `UniqueHandle = std::unique_ptr<void, HandleDeleter>` for every `HANDLE`. `CloseHandle` runs in the deleter.
- **`RingBuffer`** owns its `VirtualAlloc`-backed memory; the destructor calls `VirtualFree`.
- **RAII for ETW/USN threads** via `std::jthread`: on `HarilContext` destruction we explicitly request stop and join. On any other path (errors, exception), the `std::jthread` joins in its own destructor.
- **`std::atomic<bool>` flags** for stop signalling from the producer to the ETW consumer thread (more reliable than `stop_token` here because we don't pass `stop_token` through `std::jthread` constructors in this MSVC version).

### Standalone Distribution (Single-File Binary)

To distribute a single self-contained `haril.exe` without requiring a loose `haril_native.node` file alongside it:

```powershell
bun run build
```

This executes:
1. Builds x64 and arm64 native addons with MSBuild.
2. Temporarily injects both addons into the empty payload module.
3. Runs `bun build --compile` to generate a single executable containing the
   Bun runtime, UI, SQLite engine, and native addons.
4. Restores the empty source module in a `finally` block.

The final bundling step can also be invoked with `bun run build:standalone`
after `bun run build:native:all`. Missing architectures are treated as an
error so an incomplete Windows distribution is not produced accidentally.

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

## Reading events from the disruptor ring buffer

The native addon exposes a `drain(ctx, maxSlots)` API that reads whole records from the lock-free ring buffer. This is the sole consumer-facing entry point for captured events.

### Event flow pipeline

```text
ETW Kernel Callback
  │
  ▼
EtwEventCallback()          ← Windows kernel delivers events via PEVENT_RECORD
  │
  ├─► Decode MOF properties (TDH schema, property offsets)
  │     └─▏ Opcode → event kind (Create/Read/Write/Close/…)
  │     └─▏ FileObject/Key lookup (tracked in etwObjPaths / etwKeyPaths)
  │     └─▏ Path translation (device prefix → drive letter, scope check)
  │
  ├─► encode_event_slot()    ← fills 1024-byte slot buffer
  │
  └─► ring.push_record()     ← CAS-atomically claim slot, publish flags
       │
       ▼
USN Journal Thread
  │
  ▼
usn_thread_entry()           ← DeviceIoControl FSCTL_READ_USN_JOURNAL
  │
  ├─► Read USN records from NTFS journal
  │   └─▏ Resolve FRN → path (via parent FRN cache or OpenFileById)
  │   └─▏ Apply scope filter (usnTargetRoot)
  │
  ├─► encode_event_slot()    ← fills slot with source=USN, kind=Notify
  │   └─► encode_usn_extension() ← writes FRN, parentFRN, usn, reason at [176..204]
  │
  └─► ring.push_record()     ← same lock-free MPSC path
```

### How `drain()` works

- Calls `ring.pop_batch(out_span, &seq)` to extract up to `maxSlots` **whole records**
- The consumer iterates slots checking `available_[index].load(acquire) == seq + 1`
- Verifies all continuation slots of a multi-slot record are published before copying
- For ETW records, enriches each slot with the process image name via `process_name(pid)`
- Returns `ArrayBuffer` of `n × HARIL_SLOT_SIZE` bytes (1,024 bytes per slot)
- **Backpressure**: if the ring is full, the producer drops the whole record and increments `etwRingPushFailed`

### Slot layout (1,024 bytes, little-endian)

| Offset | Size | Field |
|--------|------|-------|
| 0 ‑ 1 | 2 | **source** — 1=ETW, 2=USN, 3=FSW |
| 2 ‑ 3 | 2 | **kind** — event kind (Create=1, Open=2, Read=3, Write=4, SetInfo=5, Close=6, Rename=7, Delete=8, OpEnd=9, Notify=10) |
| 4 ‑ 11 | 8 | **timestamp_ns** — nanosecond timestamp (QPC → ns conversion) |
| 12 ‑ 15 | 4 | **pid** — process identifier |
| 16 ‑ 19 | 4 | **tid** — thread identifier |
| 20 ‑ 27 | 8 | **irpPtr** — IRL pointer (overlapped I/O), or 0 |
| 28 ‑ 31 | 4 | **ntStatus** — NT status code (0 when none) |
| 32 ‑ 47 | 16 | **fileId128** — FILE_ID_128 bytes (16) |
| 48 ‑ 51 | 4 | **volumeSerial** — volume serial number |
| 52 ‑ 55 | 4 | **byteOffset** — low 32 bits of byte offset |
| 56 ‑ 59 | 4 | **byteLength** — request byte length |
| 60 ‑ 63 | 4 | **shareAccess** — share mode |
| 64 ‑ 67 | 4 | **createOptions** — creation options (first 24 bits) |
| 68 ‑ 71 | 4 | **createDisposition** — create disposition (high 8 bits of options) |
| 72 ‑ 75 | 4 | **sourceEventIndex** — monotonic event counter |
| 76 ‑ 77 | 2 | **pathLen** — total UTF-16 units of observed path (up to 32767) |
| 78 ‑ 79 | 2 | **procLen** — process image name length in UTF-16 units |
| 80 ‑ 81 | 2 | **extraSlots** — number of continuation slots following |
| 112 ‑ 175 | 64 | **processImage** — process image name (UTF-16LE, 32 units = max 64 chars) |
| 176 ‑ 203 | 28 | **USN extension** — present only for USN records: FRN (u64), parentFRN (u64), usn (u64), reason (u32) |
| 256 ‑ 1023 | 768 | **observedPath** — first 384 UTF-16 units stored inline; remaining units in continuation slots |

If `pathLen > 384` (i.e., `PATH_INLINE_CHARS`), the remaining path units continue in `extraSlots` continuation slots of raw UTF-16LE. Each continuation slot provides `HARIL_SLOT_SIZE / 2 = 512` UTF-16 units. The `decodeSlots` function reads continuation slots when needed.

### TypeScript consumption

`decodeSlots()` in `ring_consumer.ts` decodes the drain `Uint8Array` into `DecodedSlot[]`:

```typescript
export function decodeSlots(bytes: Uint8Array): DecodedSlot[] {
  const out: DecodedSlot[] = [];
  const n = Math.floor(bytes.length / SLOT_SIZE);
  for (let i = 0; i < n; ) {
    const head = bytes.subarray(i * SLOT_SIZE, (i + 1) * SLOT_SIZE);
    const extra = Math.min(slotExtra(head), n - i - 1);
    const cont = extra > 0 ? bytes.subarray((i + 1) * SLOT_SIZE, (i + 1 + extra) * SLOT_SIZE) : undefined;
    out.push(decodeSlot(head, cont));
    i += 1 + extra;
  }
  return out;
}
```

Each `DecodedSlot` has the shape:

```typescript
{
  event: NormalizedEvent & { source: SourceId; sourceEventIndex: number },
  usn: UsnSlotIdentity | null,   // only present for USN-sourced slots
}
```

where `NormalizedEvent` includes: `timestamp_ns`, `eventKind`, `fileKey`, `pid`, `tid`, `processImageName`, `irpPtr`, `ntStatus`, `observedPath`, `byteOffset`, `byteLength`, `shareAccess`, `createOptions`, `createDisposition`.

### Observability counters

The disruptor maintains atomic counters useful for diagnosing capture quality. All are exposed via N-API exports:

| Counter | Meaning |
|---------|---------|
| `etwEventsObserved` | ETW events delivered to the callback |
| `etwEventsLost` | Events lost by the kernel logger (buffer overflow, etc.) |
| `etwOutOfScope` | Events whose path fell outside the configured scope root |
| `etwWithoutPath` | Events where no path could be resolved from the MOF data |
| `etwRingPushFailed` | Records dropped because the ring buffer was full (backpressure) |
| `etwPushAttempted` | Total records attempted to push (observed + failed) |
| `etwKindZero` | Events with opcode 0 (unused/neutral) |
| `etwAfterKind` | Debug counter: reached after kind check |
| `etwAfterScope` | Debug counter: reached after scope check |
| `usnRecordsRead` | Total USN journal records read |
| `usnDroppedUnresolved` | USN records that could not be resolved to a path (deleted, FRN missing) |

These counters allow diagnosing capture quality: high `etwEventsLost` / `etwRingPushFailed` indicate buffer sizing issues; high `etwOutOfScope` / `etwWithoutPath` indicate scope configuration problems; high `usnDroppedUnresolved` indicates many files deleted or with unreachable FRNs during capture.

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
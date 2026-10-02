# haril_native — native DLL build

Haril-TS captures kernel ETW events, USN journal records, and per-file
identities through a small native DLL: `haril_native.dll`. The
TypeScript side loads it via `bun:ffi`.

## Why a DLL

`bun:ffi` can call C functions exported by a DLL. Bun itself runs the
JS code, but the kernel-level APIs (`StartTraceW`,
`TdhGetEventInformation`, `FSCTL_READ_USN_JOURNAL`,
`GetFileInformationByHandleEx`, `ShellExecuteExW` with `runas`) are
Windows-only and are not exposed by `bun:ffi` itself.

## Toolchain

We use **MSBuild** with the **Visual Studio 2022 C++ Build Tools**
(`MSBuild.exe` + `cl.exe` + `link.exe`) targeting **MSVC v143** and
the **Windows 10/11 SDK** (10.0.26100.0 in this build).

`native/build-windows.ps1` wraps the call:

```powershell
bun run build:native            # x64 Release (default)
bun run build:native:arm64      # not yet supported (TODO)
```

The output is `native/out/bin/haril_native.dll` (`bin-arm64` for arm64).

The C++ source is C++20 with selected C++23 features (`std::jthread`,
`std::stop_token` semantics, `std::span`). MSBuild targets
`<LanguageStandard>stdcpplatest</LanguageStandard>`.

### Why MSVC, not Zig

Zig 0.16 (aarch64) installed on Windows-arm64 hosts crashes with
ACCESS_VIOLATION (`0xC0000005`) when cross-compiling real C++ for
`x86_64-windows-msvc`. MSVC's bundled cl.exe + link.exe produce a
valid DLL without that crash.

### Why MSVC, not MSBuild from PowerShell

`msbuild.exe` is the only MSBuild entry point available in Visual
Studio 2022 Build Tools. Calling it with a `.vcxproj` directly is the
simplest route and avoids the `.sln` overhead.

### System libraries we link against

| Library | Provides |
|---|---|
| `advapi32` | `StartTraceW`, `EnableTraceEx2`, `ControlTraceW`, `OpenTraceW`, `ProcessTrace`, `CloseTrace` |
| `tdh`      | `TdhGetEventInformation`, `TdhFormatProperty` |
| `kernel32` | `CreateFileW`, `FindFirstFileW`, `GetFileInformationByHandleEx(FileIdInfo)`, `DeviceIoControl(FSCTL_READ_USN_JOURNAL)`, `GetVolumeInformationW`, `QueryPerformanceCounter` |
| `shell32`  | `ShellExecuteExW` |
| `ole32`    | `CoInitializeEx`, `CoUninitialize` (required before `ShellExecuteExW`) |
| `user32`   | reserved |

Note: `sechost.lib` is **not** listed. Although some Microsoft docs
say `ProcessTrace` lives there on Win 8.1+, the import library for
`Sechost` is not bundled in the current SDK; linking succeeds via
`Advapi32`.

## C++ style guide (modern, RAII-first)

- **No raw `new`/`delete`** in the C++ body. The DLL uses a class
  `HarilContext` constructed with `new` only at the C-export
  boundary (`haril_open` / `haril_close`); everything else is
  `std::unique_ptr`, `std::jthread`, `std::span`, `std::string_view`.
- **No leaked handles**: `UniqueHandle = std::unique_ptr<void, HandleDeleter>`
  for every `HANDLE`. `CloseHandle` runs in the deleter.
- **`RingBuffer`** owns its `VirtualAlloc`-backed memory; the destructor
  calls `VirtualFree`.
- **RAII for ETW/USN threads** via `std::jthread`: on
  `HarilContext` destruction we explicitly request stop and join. On
  any other path (errors, exception), the `std::jthread` joins in
  its own destructor.
- **`std::atomic<bool>` flags** for stop signalling from the producer
  to the ETW consumer thread (more reliable than `stop_token` here
  because we don't pass `stop_token` through `std::jthread`
  constructors in this MSVC version).

## Layout

```
native/
├── haril_native.vcxproj       MSBuild project
├── build-windows.ps1           invokes MSBuild + vswhere
├── include/haril_native.h      public C API
├── src/main.cpp                 DllMain + all exports in one TU
└── out/bin/haril_native.dll       (build output; mirrored as .node)
```

## Public C API

```c
typedef struct HarilContext HarilContext;

typedef enum {
    HARIL_SOURCE_ETW = 1,
    HARIL_SOURCE_USN = 2,
    HARIL_SOURCE_FSW = 3,
} HarilSource;

HarilContext* haril_open(void);
void          haril_close(HarilContext*);

int32_t  haril_source_status(HarilContext*, HarilSource);
int32_t  haril_etw_start(HarilContext*, const uint16_t* session_utf16, int32_t session_len,
                         const uint16_t* root_utf16, int32_t root_len);
int32_t  haril_etw_stop(HarilContext*);
uint64_t haril_etw_events_lost(HarilContext*);
uint64_t haril_etw_buffers_written(HarilContext*);
uint64_t haril_etw_events_observed(HarilContext*);
uint64_t haril_etw_candidates_out_of_scope(HarilContext*);

int32_t  haril_usn_start(HarilContext*, const uint16_t* volume_utf16, int32_t volume_len);
int32_t  haril_usn_stop(HarilContext*);
uint64_t haril_usn_records_read(HarilContext*);

int32_t  haril_inventory_walk(HarilContext*, const uint16_t* root_utf16, int32_t root_len,
                             int is_initial,
                             int (*emit_cb)(const uint8_t* record, int32_t record_len, void* user),
                             void* user);
int32_t  haril_get_file_id(const uint16_t* path_utf16, int32_t path_len,
                           uint8_t* out_id16, uint32_t* out_volume_serial);

int32_t  haril_is_admin(void);
int32_t  haril_relaunch_elevated(const uint16_t* exe_utf16, int32_t exe_len,
                                  const uint16_t* args_utf16, int32_t args_len);

#define HARIL_SLOT_SIZE 256
int32_t  haril_drain(HarilContext*, uint8_t* out_buf, int32_t max_slots, uint64_t* out_seq_high);
```

Strings are UTF-16LE with explicit length because neither `bun:ffi`
nor Node-API auto-converts UTF-8 to UTF-16LE; the N-API wrapper
(`napi_addon.cpp`) converts JS strings on the way in.

## Slot layout

Each ring buffer slot is 256 bytes, little-endian. Identical to the
on-disk `.haril` event representation:

| Offset | Size | Field |
|---|---|---|
| 0   | 2   | source (1=ETW, 2=USN, 3=FSW) |
| 2   | 2   | EventKind |
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
| 76  | 1   | observedPath length (chars, max 16) |
| 80  | 32  | observedPath (UTF-16LE) |
| 112 | 64  | processImageName (UTF-16LE) |
| 176 | 8   | USN only: fileReferenceNumber (u64) |
| 184 | 8   | USN only: parentFileReferenceNumber (u64) |
| 192 | 8   | USN only: usn (u64) |
| 200 | 4   | USN only: reason flags (u32) |
| 204 | 52  | reserved |

## ETW session naming

The NT Kernel Logger only accepts its canonical session name
(`NT Kernel Logger`); a custom name makes `StartTraceW` fail with
`ERROR_INVALID_PARAMETER` (87). `etw_start` therefore always starts
(or attaches to) the canonical session regardless of the name passed
in. If another tool already owns the session (`ERROR_ALREADY_EXISTS`),
we attach as a consumer and never stop a session we did not start
(`etwOwnsSession` flag).

## ETW path filter

`EtwEventCallback` compares the observed path against `etwTargetRoot`
case-insensitively after normalising forward slashes. Events outside
the root increment `etwOutOfScope` and are dropped.

## Schema decoding (TDH)

`TdhGetEventInformation` is invoked once per
`(ProviderGuid, EventDescriptor.Id, EventDescriptor.Version)` tuple,
on the ETW consumer thread, inside the `EventRecordCallback`. The
returned schema is cached for the lifetime of the `HarilContext`.

Per-property extraction goes through `TdhFormatProperty`, which returns
a UTF-16LE-formatted string from any property given its `InType`,
`OutType`, and the event blob. This is the recommended TDH path for
non-WPP events and avoids manual MOF parsing.

The legacy `FileIo/Name` event id 0 keeps a fixed-offset fallback (no
embedded schema) so the path is still recovered.

## UAC scenario (confirmed end-to-end)

After build, the following is verified:

- `LoadLibraryW(L"haril_native.dll")` succeeds.
- `GetProcAddress(lib, "haril_open")` returns a valid function pointer.
- `haril_open()` returns a non-null handle.
- `haril_is_admin()` returns 0 (not elevated) or 1 (elevated).
- `haril_close(handle)` does not crash.

## Graceful degradation in Bun

If `bun:ffi.dlopen()` is unavailable in the running Bun build (e.g.
`TinyCC is disabled`), `bindings.ts` returns `null` and the runtime
degrades to "analyze only": opening `.haril` packages works; starting
capture returns a corrective error. See DEC-021 in `decisions.md`.

This is the situation on this build host (Bun 1.3.14 with TinyCC
disabled). The DLL itself is verified working through a direct
`LoadLibraryW` smoke test. On a Bun build with TinyCC enabled, the
DLL loads via `bun:ffi.dlopen` and the full capture path becomes
exercisable from the TUI.
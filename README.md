# Haril-TS

File-lifecycle reconstruction for Windows NTFS, in **Bun + TypeScript**.
Reimplemented, faithful to the idea (not the code), of [Haril](https://github.com/fasaled/haril).
UX and architecture inspired by [`muin`](https://github.com/fasaled/muin)
and [`sailkari`](https://github.com/fasaled/sailkari).

## What it does

- Records factual file activity under a chosen directory tree on NTFS,
  during a 1–300 s capture window.
- Combines three sources:
  - **Windows Kernel ETW** (`Microsoft-Windows-Kernel-File`,
    `Microsoft-Windows-Kernel-Process`,
    `Microsoft-Windows-Kernel-Image`) via
    `TdhGetEventInformation`.
  - **NTFS USN Journal** via `FSCTL_READ_USN_JOURNAL`.
  - **FileSystemWatcher** (user-mode path notifications).
- Produces a portable `.haril` archive (ZIP + JSONL streams + SHA-256
  manifest).
- Opens the archive in the same TUI for analysis: parallel file lanes
  on a shared UTC axis, source-fidelity evidence, file-centric only,
  no inferred causality.
- Exposes the same `FileTimelineCommands` query core to an MCP stdio
  server.

## Constraints

- **Bun runtime only**. The published executable is built with
  `bun build --compile` and contains the Bun runtime + the JS bundle.
- **Windows only** (`os: ["win32"]`). Capture refuses non-NTFS volumes.
- **Elevation required** to start capture (NT Kernel Logger).
  Auto-relaunched via `ShellExecuteExW(Verb="runas")` when not
  elevated; preservable session state written to
  `%LOCALAPPDATA%/Haril/pending-session.json` (DEC-048).
- Capture is invoked **inside the TUI** (`start-capture`); there is no
  `haril capture` CLI.
- The package is the durable source of truth; the live SQLite index
  is rebuilt from the package when analysis starts.

## Native addon

Capture uses `haril_native.node`, a Node-API addon built from C++ with
MSBuild + MSVC. See [`docs/native.md`](docs/native.md) for the linker
targets and build steps.

The addon is **optional at runtime**: without it the TUI/MCP can still
open existing `.haril` packages and run analysis, but capture falls
back to a TS-only path (FSW + `stat` inventories, no ETW/USN).

## Requirements

- Bun 1.3+ (already inside the compiled executable).
- For development: Bun 1.3+, Visual Studio 2022 Build Tools with the
  C++ workload (to build `haril_native.node`).
- Windows 11 with an NTFS volume.

## Run

### Using the standalone executable

The compiled executable in `dist/haril.exe` (built with
`bun build --compile`) contains everything and needs no Bun
installation:

```powershell
dist\haril.exe --version
dist\haril.exe help
dist\haril.exe mcp packages\core\test\fixtures\smoke.haril
dist\haril.exe                          # launches TUI (Empty phase)
dist\haril.exe --resume-pending         # resumes a pending capture
dist\haril.exe completion bash | Out-String | Invoke-Expression
```

### From source

```bash
bun install
bun run build:native     # haril_native.node x64 (requires MSVC Build Tools)
bun run dev              # launches the TUI
bun run mcp              # launches the MCP stdio server
bun run build:exe        # produces dist/haril.exe
```

## Tests

```bash
bun test                 # 24 unit + integration + MCP smoke tests
bun run typecheck        # tsc --noEmit
```

## Project structure

```
packages/
├── core/                 @haril-ts/core (private workspace)
│   ├── src/
│   │   ├── model/        types, FileKey helpers
│   │   ├── store/        SQLite schema + import
│   │   ├── package/      ZIP writer/reader + SHA-256 manifest
│   │   ├── commands/     parse, complete, FileTimelineCommands
│   │   ├── ffi/          Node-API loader + ring-buffer consumer
│   │   └── session.ts    HarilSession (single command core)
│   └── test/             unit + integration tests + fixtures
└── cli/                  @haril-ts/cli (public, bin: haril)
    └── src/
        ├── cli.ts        router (TUI / MCP / completion / --resume-pending)
        ├── mcp/          MCP stdio server
        ├── tui/          Ink + React components
        └── resume.ts     pending-session.json helper
native/                   C++ source compiled with MSBuild/MSVC
docs/                     design.md, decisions.md, agents.md, native.md
```

## License

MIT.
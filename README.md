# Haril-TS

File-lifecycle reconstruction for NTFS Windows, in **Bun + TypeScript**.

## What it does

- Records factual file activity under a chosen directory tree on NTFS,
  during a 1–300 second capture window.
- Combines three sources:
  - **Windows Kernel ETW** (`Microsoft-Windows-Kernel-File`,
    `Microsoft-Windows-Kernel-Process`,
    `Microsoft-Windows-Kernel-Image`) via the native addon.
  - **NTFS USN Journal** via `FSCTL_READ_USN_JOURNAL`.
  - **FileSystemWatcher** (user-mode path notifications).
- Produces a portable `.haril` archive (ZIP + JSONL streams + SHA-256
  manifest). The same archive can be opened in another machine for
  analysis. The same `FileTimelineCommands` query service powers both
  the TUI (Ink + React) and an MCP stdio server.

## Constraints

- **Bun runtime only**. The published executable is built with
  `bun build --compile` and contains the Bun runtime + the JS bundle.
- **Windows only for capture** (`os: ["win32"]`). The native addon
  (`haril_native.node`) provides ETW + USN journal + FSW callbacks
  exclusively on Windows. Capture refuses non-NTFS volumes.
- **Elevation required** to start capture (NT Kernel Logger).
  Auto-relaunched via `ShellExecuteExW(Verb="runas")` when not
  elevated; preservable session state written to
  `%LOCALAPPDATA%/Haril/pending-session.json` (DEC-048).
- Capture is invoked **inside the TUI** (`start-capture`); there is no
  `haril capture` CLI.
- The package is the durable source of truth; the live SQLite index
  is rebuilt from the package when analysis starts.

- **Non-Windows** (macOS, Linux): the native addon is not built.
  The TUI/MCP can still open and analyze existing `.haril` packages,
  but `start-capture` is not available. The project degrades gracefully
  to analysis-only on these platforms.

## Native addon

Capture uses `haril_native.node`, a Node-API addon built from C++
with MSBuild + MSVC. See [`docs/native.md`](docs/native.md) for the
linker targets and build steps.

The native capture engine uses a **Disruptor-style Lock-Free Ring Buffer (MPSC)**
backed by `VirtualAlloc` (256k slots × 256 bytes = 64 MiB). Multiple producers
(high-frequency Kernel ETW callback + background NTFS USN journal thread)
claim sequence tickets atomically via `fetch_add` and publish via atomic slot
markers. This eliminates lock contention and thread synchronization bottlenecks,
preventing ETW buffer drops (`EventsLost`) even during heavy disk I/O.

The addon is **required on Windows** for capture functionality
(ETW + USN journal + FSW callbacks). Without it, the TUI
`start-capture` command returns an error and no live capture is
possible. However, opening and analyzing existing `.haril` packages
still works — the TUI enters analyze phase with a summary indicating
the addon is missing.

On non-Windows hosts (macOS, Linux), the native addon is not built
and the project degrades fully: no capture (those OSes don't have
NTFS/ETW/USN in the same way), but `.haril` analysis packages opened
from Windows can be inspected, searched, and summarized.

This keeps the project cross-platform for analysis-only use cases
while ensuring Windows capture always requires the native addin.

## Requirements

- Bun 1.3+ (already inside the compiled executable).
- For development: Bun 1.3+, Visual Studio 2022 Build Tools with the
  C++ workload (to build `haril_native.node`).
- Windows 11 with an NTFS volume (for capture).

## Distribution & Run

### Distribution on Windows

The default Windows distribution is a **single-file standalone binary** (`dist/haril.exe`).
It embeds the Bun JS runtime, SQLite engine, CLI/TUI, and the native C++ capture engine (`haril_native.node`) into a single executable.
On first run, it automatically extracts the native addon to `%LOCALAPPDATA%\Haril\bin\<arch>\haril_native.node` so no separate DLL/.node files need to be shipped.

```bash
bun run build:standalone    # produces dist/haril.exe
```

### Using the standalone executable

The compiled standalone executable contains everything and needs no Bun installation:

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
bun run build:native          # haril_native.node x64 (requires MSVC Build Tools)
bun run dev                   # launches the TUI
bun run mcp                   # launches the MCP stdio server
bun run build:standalone      # produces standalone dist/haril.exe
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
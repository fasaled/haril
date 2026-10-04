# Haril

File-lifecycle reconstruction for NTFS Windows, in **TypeScript + Node-API**.

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

- **Node.js and Bun**. The npm package supports Node.js 22.5+ through
  `node:sqlite` and Bun 1.3.x through `bun:sqlite`. The standalone executable
  contains the Bun runtime and needs neither runtime installed.
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

- npm package: Node.js 22.5+ or Bun 1.3.x.
- Standalone executable: no separate JavaScript runtime.
- For development: Bun 1.3.x, Visual Studio 2022 Build Tools with the
  C++ workload (to build `haril_native.node`).
- Windows 11 with an NTFS volume (for capture).

Install dependencies from the committed lockfile:

```bash
bun install --frozen-lockfile
```

## Distribution & Run

### Distribution on Windows

The default Windows distribution is a **single-file standalone binary** (`dist/haril.exe`).
It embeds the Bun JS runtime, SQLite engine, CLI/TUI, and the native C++ capture engine (`haril_native.node`) into a single executable.
On first run, it automatically extracts the native addon to `%LOCALAPPDATA%\Haril\bin\<arch>\haril_native.node` so no separate DLL/.node files need to be shipped.

```bash
bun run build              # builds both native architectures and dist/haril.exe
```

### Using the standalone executable

The compiled standalone executable contains everything and needs no Node.js or
Bun installation:

```powershell
haril.exe --version
haril.exe help
haril.exe mcp packages\core\test\fixtures\smoke.haril
haril.exe                          # launches TUI (Empty phase)
haril.exe --resume-pending         # resumes a pending capture
haril.exe completion bash | Out-String | Invoke-Expression
haril.exe doctor                   # verifies runtime and native addon
```

### From source

```bash
bun install --frozen-lockfile
bun run build:native          # development addon for x64 (requires MSVC Build Tools)
bun run dev                   # launches the TUI
bun run mcp                   # launches the MCP stdio server
bun run build                # builds native addons and standalone distribution
```

`bun run build` is the portable top-level build. On Windows it builds both
native architectures before producing the standalone executable. On macOS and
Linux it skips the Windows-only addon and produces an analysis-only executable.
Distribution builds inject native payloads only while bundling and restore the
checked-in empty payload module even when the build fails.

`bun run build:standalone` only performs the final bundling step. On Windows it
expects both `native/out/bin/haril_native.node` and
`native/out/bin-arm64/haril_native.node` to have been produced already by
`bun run build:native:all`.

## Tests

```bash
bun test                 # unit, integration, native, CLI, and MCP tests
bun run typecheck        # tsc --noEmit
```

## Privacy and responsible use

Haril capture packages can contain sensitive forensic metadata, including file
and directory paths, process names, timestamps, file identifiers, filesystem
events, and inventory data. They do not intentionally include file contents,
but names and activity patterns alone may disclose confidential information.

Only capture systems and directories you are authorized to inspect. Review a
`.haril` package before sharing it, treat it as sensitive evidence, and transfer
or store it using protections appropriate for the captured environment.

For vulnerability reports, see [`SECURITY.md`](SECURITY.md).

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

MIT. Copyright (c) 2026 Francisco Sánchez.

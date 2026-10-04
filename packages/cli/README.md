# Haril

Haril reconstructs and analyzes file activity from portable `.haril` capture
packages.

It is designed for Windows NTFS investigation and combines:

- Windows Kernel ETW file, process, and image events.
- NTFS USN Journal records.
- User-mode filesystem notifications.
- Initial and final file inventories with file identities.

The result is a self-contained package that can be opened later for analysis,
without keeping a live database as the source of truth.

## Install

Haril is published to **npm** and runs on either Node.js or Bun:

```powershell
npm install --global @fasaled/haril
haril --help
```

For Node.js, use Node 22.5 or newer because the analysis index uses the
standard `node:sqlite` API. Bun 1.3.x or newer is also supported and uses its
native SQLite implementation. You can install the package locally with npm:

```powershell
npm install @fasaled/haril
```

The installed `haril` command uses Node.js, which is the standard npm runtime.
To run the same bundle explicitly with Bun:

```powershell
bun ./node_modules/@fasaled/haril/dist/cli.js --help
```

The package includes the CLI bundle and native capture addons for Windows x64
and ARM64. A standalone executable built from the repository includes its
runtime and does not require a separate Node.js or Bun installation.

## Platform support

| Platform | Open and analyze `.haril` packages | Capture new activity |
| --- | --- | --- |
| Windows x64 | Yes | Yes, on NTFS with administrator privileges |
| Windows ARM64 | Yes | Yes, on NTFS with administrator privileges |
| macOS | Yes | No, analysis-only |
| Linux | Yes | No, analysis-only |

Windows capture starts the NT Kernel Logger and therefore requires elevation.
Haril can relaunch the capture process with administrator privileges and
preserve the pending session under `%LOCALAPPDATA%\Haril`.

Capture is supported for NTFS volumes only. The native addon is optional for
analysis: a machine without the addon can still open and query packages
captured elsewhere.

## Command line

```text
haril                         Launch the interactive TUI
haril mcp [path.haril]        Start the MCP server over stdio
haril completion <shell>      Print shell completion
haril doctor                  Check runtime and native-addon availability
haril --version               Show the installed version
haril help                    Show command help
```

Examples:

```powershell
# Check the installation and native capture support
haril doctor

# Open a package through the interactive interface
haril mcp C:\evidence\session.haril

# Generate PowerShell completion
haril completion powershell
```

The default command opens the TUI. The TUI has three phases:

1. **Empty** — inspect the local filesystem, open an existing package, or
   start a capture.
2. **Live capture** — view events while the capture window is running and stop
   or cancel it.
3. **Analyze** — browse file timelines, inspect events, search paths and
   process names, and review session totals.

Inside the TUI, the main commands are:

```text
ls [path]                         List files or timelines
cd <directory>                    Change the working directory
pwd                               Show the current directory
open <path.haril>                 Open an existing package
start-capture                     Start a 1–300 second capture
stop-capture                      Stop the active capture
events                            Inspect file events
evidence                          Inspect one event
overview                          Show session-wide totals
summary                           Summarize a file timeline
dirs                              List observed directories
search <text>                     Search paths and process names
size-changes                      Show file size changes
close                             Close the active package
```

To start a capture, use `start-capture` and its optional flags:

```text
start-capture --root <directory> --output <file.haril> --seconds <1..300>
```

When omitted, the root is the current working directory, the output is a
timestamped `.haril` file in that directory, and the capture lasts 30 seconds.

## MCP server

The MCP server uses stdio and exposes read-only analysis tools for the active
package. Start it with:

```bash
haril mcp C:\evidence\session.haril
```

Available tools include:

- `open_capture_package`
- `close_capture_package`
- `get_capture_summary`
- `get_session_activity_overview`
- `list_observed_directories`
- `search_file_timelines`
- `browse_file_timelines`
- `inspect_file_timeline`
- `inspect_file_timeline_event`

The MCP server does not perform live capture. It opens a `.haril` package and
exposes its factual records to an MCP client such as an AI assistant.

## `.haril` packages

A `.haril` file is a portable ZIP-based archive containing JSONL data streams
and a SHA-256 manifest. It can include:

- capture metadata and source availability;
- initial and final file inventories;
- normalized file events;
- USN records;
- filesystem notifications;
- file identities and timeline keys.

Haril does not intentionally store file contents. However, package metadata can
still reveal sensitive paths, directory names, process names, timestamps,
identifiers, and activity patterns. Only capture systems you are authorized to
inspect, and review a package before sharing it.

## Troubleshooting

Run:

```bash
haril doctor
```

On Windows, `Native capture: available` confirms that the architecture-matched
addon can be loaded. If it reports `unavailable`:

1. Confirm that Node.js 22.5+ or Bun 1.3.x is being used.
2. Confirm that the package was installed for the current architecture.
3. Run the command from an elevated terminal when starting capture.
4. Check that the target volume is NTFS.

Analysis of an existing package does not require native capture support.

## Development

Source code, native build instructions, and the test suite are available at
[github.com/fasaled/haril-ts](https://github.com/fasaled/haril-ts).

```bash
git clone https://github.com/fasaled/haril-ts.git
cd haril-ts
bun install --frozen-lockfile
bun test
bun run typecheck
bun run lint
```

Windows native development additionally requires Visual Studio 2022 Build Tools
with the C++ workload:

```powershell
bun run build:native:all
bun run build:standalone
```

## License

MIT. Copyright (c) 2026 Francisco Sánchez.

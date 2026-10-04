# Haril

Haril reconstructs and analyzes file activity from `.haril` packages.

## Install

```bash
bun add -g @fasaled/haril
haril --help
```

The package requires Bun 1.3.x and includes the bundled CLI and the Windows native capture addon for
x64 and arm64. Windows capture requires an NTFS volume and administrator
privileges. On macOS and Linux, Haril runs in analysis-only mode and can open
`.haril` packages produced on Windows.

Capture packages may contain sensitive paths, process names, timestamps, file
identifiers, and activity metadata. Only capture systems you are authorized to
inspect, and review packages before sharing them.

## Commands

```text
haril                         Interactive TUI
haril mcp [path.haril]        MCP server over stdio
haril completion <shell>      Print shell completion
haril doctor                  Check runtime and native addon
haril --version               Show the installed version
```

The package is built from the source repository at
https://github.com/fasaled/haril-ts.

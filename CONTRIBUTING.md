# Contributing

Haril is a personal project, but focused bug reports and small, well-tested
changes are welcome.

## Development setup

1. Install Bun 1.3.x. The reference version is recorded in `.bun-version`.
2. Run `bun install --frozen-lockfile`.
3. Run `bun test`, `bun run typecheck`, and `bun run lint`.

Windows capture development additionally requires Visual Studio 2022 Build
Tools with the C++ workload and a Windows 10 or 11 SDK. Build the addon with:

```powershell
bun run build:native
```

## Changes

- Keep changes focused and include tests for observable behavior.
- Preserve analysis-only operation on macOS and Linux.
- Do not commit build outputs, native binaries, capture packages, or generated
  embedded payloads.
- Update documentation when commands, requirements, or package formats change.
- Do not include private `.haril` captures in issues or test fixtures.

Use `bun run format` to format TypeScript sources and `bun run format:check`
to check formatting without changing files.

By contributing, you agree that your contribution is licensed under the MIT
License used by this repository.

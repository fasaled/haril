# Working with Haril-TS as an agent

Conventions for AI-assisted development on this repo.

## Repo layout

This project has three logical layers:

- `packages/core/` — `@haril-ts/core` (private workspace). Pure logic: model, store, commands, package format, native-addon loader.
- `packages/cli/` — `@haril-ts/cli` (public npm package). TUI (Ink + React), MCP server, shell completion.
- `native/` — C++ source compiled with **MSBuild + MSVC** into `haril_native.node` (Node-API addon; build output mirrored from the DLL).

## Architecture

- One source of truth: `HarilSession.run(line)` in `packages/core/src/session.ts`. The TUI and MCP both call into it.
- All persistence (live and analysis indexes) is `bun:sqlite`. Schema in `packages/core/src/store/schema.ts`.
- The `.haril` package is a ZIP (`STORE`) with SHA-256-protected entries; writer/reader in `packages/core/src/package/`.
- Native capture goes through `packages/core/src/ffi/bindings.ts`, which loads `native/out/bin[-<arch>]/haril_native.node` via `require()` (platform-aware: `bin` for x64, `bin-arm64` for arm64). No `bun:ffi`, no Zig anywhere.

## Build cycle

```bash
bun install                # workspace install
bun test                   # unit + integration tests
bun run typecheck          # tsc --noEmit
bun run build:native       # native addon via MSBuild (x64 Release)
bun run build:native:arm64 # native addon via MSBuild (arm64 Release)
bun run build              # JS bundle + standalone haril.exe
```

The native addon is **required on Windows** for capture functionality. Without it, the JS code degrades gracefully and you can still run the test suite and analyze packages.

## When the user asks for a feature

1. Identify which layer (model, store, commands, package, TUI, MCP, native).
2. If it touches data shape: update `model/types.ts` first.
3. If it touches commands: update `commands/parse.ts`, `commands/complete.ts`, then `commands/file_timeline.ts`, then `session.ts`.
4. If it touches the TUI: update `tui/App.tsx` and `tui/components/*`.
5. If it touches the MCP: update `cli/src/mcp/serve.ts`.
6. Add or extend a test.
7. Run `bun test` and `bun run typecheck`.

## When the user asks for a capture-side change

- ETW decode/callback: `native/src/core.cpp`, `Impl::EtwEventCallback` and the manual MOF-offset parser helpers. Session lifecycle: `Impl::etw_start` / `Impl::etw_stop`. Kernel sessions always use the canonical `NT Kernel Logger` name; a pre-existing session is attached to, never stopped.
- USN: `native/src/core.cpp`, `Impl::usn_thread_entry` / `usn_start` / `usn_stop`. USN identity fields travel in the slot extension block `[176..204]` (see `encode_usn_extension`).
- Inventory: `native/src/core.cpp`, `walk_dir_rows` (paths + `FILE_ID_INFO`).
- Schema caching: `HarilContext::Impl::get_schema`.
- N-API surface: `native/src/napi_addon.cpp`. New exports need an entry in the `EXPORT(...)` list, a matching member in `packages/core/src/ffi/bindings.ts`, and headers from `node-api-headers` (devDependency; never `node-addon-api`).
- Link inputs: `native/node.lib` (x64) / `native/node-arm64.lib`, downloaded from `nodejs.org/dist` by `build-windows.ps1`. Both are gitignored.

After changing the native side:

```bash
bun run build:native
bun test
```

Validate the addon under an x64 runtime when on ARM64 hardware (the x64 `.node` cannot load into an arm64 process):

```bash
C:\tmp\nodex64\node-v24.18.0-win-x64\node.exe scripts/probe-addon.cjs
```

## When tests fail

The most common failures:

- `Bun: Binding expected string, TypedArray, boolean, number, bigint or null` — pass `Buffer.from(uint8Array)` instead of the raw `Uint8Array` to `db.query(...).run()`.
- `Type 'unknown[]' does not satisfy 'SQLQueryBindings'` — type the generic to `(string | number | null)[]` instead of `unknown[]`.
- Typecheck errors after a model change — usually `index.ts` needs new exports.
- Stale `smoke.haril` fixture: regenerate with `bun run packages/core/test/fixtures/make-fixture.ts` before `bun test`.
- MSBuild `C1083: Cannot open include file 'node_api.h'`: the `node-api-headers` devDependency is missing or `$(NodeApiHeadersDir)` is misconfigured in `haril_native.vcxproj`.
- MSBuild `LNK2001: unresolved external symbol napi_*`: `native/node.lib` (or `node-arm64.lib`) is missing; the build script downloads it from `nodejs.org` — check network access.
- `LoadLibrary failed: %1 is not a valid Win32 application` when loading the addon: architecture mismatch (x64 `.node` in an arm64 process or vice versa). Build/select the `.node` matching `process.arch`.

## Conventions

- Pure functions preferred over stateful modules.
- No `any` in `packages/core/`; `any` is OK only at the FFI boundary in `bindings.ts` and `ring_consumer.ts`.
- Do not introduce new dependencies without checking that the package works under Node (the published bin runs under Node, not Bun).
- `bun:sqlite` is Bun-only; it works under Bun test runs but would not work in a Node-published bin. The published bin never invokes the live store; it always imports a `.haril` first.
- Native code is modern C++ (`stdcpplatest`): RAII handles (`UniqueHandle`), `std::jthread` with atomic stop flags, `std::span` for buffers, no raw owning pointers outside the C-export boundary. Keep `<windows.h>` out of public headers (`core.h` is pimpl-style).
- Never install dependencies outside the repo (no `C:\tmp\nodeapi` style workarounds). Dev-only headers belong in `devDependencies` (`node-api-headers`), never vendored by hand into `native/include/`.

---
*All conventions are self-contained for this project.*
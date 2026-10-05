# Changelog

All notable changes to Haril will be documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- Made distribution builds reproducible from the committed Bun lockfile.
- Kept generated native payloads out of the checked-in source tree.
- Made the top-level build degrade to analysis-only outside Windows.
- Allowed MSBuild to select an installed Windows 10 or 11 SDK.
- Clarified privacy, security, contribution, and release documentation.
- Added Node.js 22.5+ compatibility to the npm CLI while retaining Bun 1.3.x
  and standalone executable support.
- Built explicitly named `haril-x64.exe` and `haril-arm64.exe` standalone
  artifacts while retaining both native addons in the cross-architecture npm
  package.
- Decoded the USN record reason into a lifecycle event kind (`Create`, `Write`,
  `Rename`, `Delete`, `SetInfo`, `Close`) instead of emitting every journal
  record as a generic `Notify`.

## [0.1.2] - 2026-10-04

### Changed

- Added Node.js runtime support alongside Bun for the npm package, including a
  runtime-neutral SQLite adapter and dual-runtime MCP end-to-end tests.
- Prepared the npm package for republishing with the corrected reproducible
  standalone build and native addon packaging flow.

[Unreleased]: https://github.com/fasaled/haril-ts/commits/main

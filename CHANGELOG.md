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

## [0.1.1] - 2026-10-04

### Changed

- Prepared the npm package for republishing with the corrected reproducible
  standalone build and native addon packaging flow.

[Unreleased]: https://github.com/fasaled/haril-ts/commits/main

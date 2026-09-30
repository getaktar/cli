# Changelog

All notable changes to the Aktar CLI are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.1] - 2026-09-30

### Changed

- The npm page shows the Aktar logo and a terminal demo, and links to
  getaktar.com/cli and the Homebrew formula

## [0.1.0] - 2026-09-30

### Added

- `aktar upload <files>`: uploads through the Aktar app and prints one link
  per file, as a URL, Markdown, HTML or your custom template (`--format`),
  or everything as JSON (`--json`). Pick a destination by name or ID
  (`--destination`), upload into a folder (`--folder`), let the bucket
  delete the file after 1, 7, 14 or 30 days (`--expires`), or upload the
  clipboard (`--clipboard`)
- `aktar login` and `aktar logout`, with the token from Aktar's Settings >
  Integrations, or `AKTAR_TOKEN` and `AKTAR_PORT`
- `aktar status`, `aktar destinations` and `aktar history`
- Exit codes that tell failed uploads, bad arguments and connection
  problems apart

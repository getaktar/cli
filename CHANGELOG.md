# Changelog

All notable changes to the Aktar CLI are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-10-06

### Added

- `aktar mcp`: a Model Context Protocol server on stdio for AI agents
  (Claude, Cursor, VS Code, Codex...), with tools to upload files or the
  clipboard, replace a file keeping its link, search history, list
  destinations, browse a bucket, make temporary links, show an upload's
  thumbnail and list watched folders. `--root` limits uploads to folders,
  `--read-only` offers only the tools that change nothing, and
  `--allow-delete` adds `delete_upload`. Speaks the 2026-07-28 protocol and
  the earlier `initialize` versions
- `aktar skill`: prints an agent skill (`SKILL.md`) that teaches agents to
  use the `aktar` command, for agents without MCP

## [0.3.0] - 2026-10-05

### Added

- `aktar replace <target> <file>`: writes a new file over an upload, so its
  key and link stay the same. `<target>` is an upload ID or link from
  `aktar history`, or a key in a destination's bucket with `-d` (the
  selected destination when left out). Prints the link like `aktar upload`,
  with `--format`, `--json` and `--qr`. Needs Aktar for Mac 0.14.0 or
  Aktar for Windows 0.7.0

## [0.2.0] - 2026-10-01

### Added

- `aktar upload --name <name>`: upload a single file under another name,
  which is what the destination's path template and Aktar's history use.
  The file's extension is added if the name has none. Works with `--folder`
- `aktar upload --qr`: prints a QR code of each link under it, drawn in the
  terminal black on white whatever its theme
- `aktar qr <text>`: the QR code of a link or any text, or of an upload's
  link given its ID from `aktar history`. `--png <file>` saves it as a PNG
- When Aktar reuses the link of a file that's already in the bucket instead
  of uploading it again (Aktar for Mac 0.10.0, Windows 0.3.0), `aktar` says
  so on stderr, and `--json` has `"reused": true`

### Changed

- The README explains what Aktar handles per destination without any
  options: WebP and AVIF images, `{md5}` and `{sha256}` in path templates,
  and multipart uploads with resume for files past 5 GB

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

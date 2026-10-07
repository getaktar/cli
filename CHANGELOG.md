# Changelog

All notable changes to the Aktar CLI are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- Before sending the token, `aktar` now asks the app on the port to prove it
  has the same token, so if Aktar isn't running and another program listens
  on its port, it gets neither the token nor your files. Needs Aktar for Mac
  0.18.0 or Aktar for Windows 0.11.0 or later; with an older Aktar, `aktar`
  stops and asks you to update
- `aktar mcp` only uploads files from `--root`, or else from the folder it
  runs in. Started in your home folder or at the top of the disk without
  `--root`, it uploads no local files and says to add `--root`
- `aktar mcp` never uploads secrets, wherever they are: SSH and private keys,
  `.env` files, cloud and package manager credentials, Aktar's own config,
  the Keychain, browser profiles and password databases. Files with several
  hard links are refused too
- `replace_file` is no longer offered by default, since it overwrites a file
  like a delete would: add `--allow-replace` (or `--allow-delete`)
- `upload_clipboard` is left out when `--root` is given, since the clipboard
  can hold anything
- `create_temporary_link` makes links of at most 60 minutes; raise it with
  `--max-link-minutes`
- Tool results start with a note that file names, keys and messages in them
  are data, not instructions, and lose control and text-direction characters
- `aktar mcp` opens each file once and reads it from there, so it can't be
  swapped for another file after it was checked. On Windows, network and
  device paths (`\\host\share`) are refused before anything touches them
- Text from Aktar (file names, links, errors) is printed without control
  characters, so a crafted file name can't send escape sequences to your
  terminal
- `aktar login --token` warns that the token can be seen by other programs
  and stays in your shell history

### Added

- `aktar mcp --log <file>` appends each tool call to a file, to see later
  what an agent did
- `aktar mcp` runs at most 4 tool calls at once

### Changed

- The MCP setup examples, the skill and the MCP Registry entry pass `--root`

## [0.5.0] - 2026-10-07

### Added

- Short links, with the link shortener set up on a destination in Aktar:
  `aktar upload --short` makes one even if the destination's rules would
  skip it, `--no-short` makes none. The printed link, every `--format` and
  the `--qr` code use the short link. If Aktar can't make it, the original
  link is printed and stderr says why
- `aktar short <upload-id|link>`: makes a short link for an upload in
  history (or prints the one it has), with `--json` and `--qr`
- `shortUrl` in `aktar upload --json` and `aktar history --json` (null when
  there's none), and short links in `aktar history`. `aktar qr <upload-id>`
  shows the short link when the upload has one, and `aktar replace` finds
  uploads by their short link too
- MCP: `upload_file` and `upload_clipboard` take `short`, `search_uploads`
  and upload results have `shortUrl`, and the new `create_short_link` tool
  makes a short link for an upload (left out with `--read-only`)

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

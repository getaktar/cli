---
name: aktar
description: Upload files to the user's own S3, Cloudflare R2 or Backblaze B2 bucket with the Aktar app and get shareable links, search past uploads, replace a file while keeping its link, or make temporary links. Use when the user asks to upload, share, host or get a link for a file, screenshot, build or log, or to put an image in Markdown.
---

# Aktar

The `aktar` command (npm `@getaktar/cli`) uploads through the Aktar app running on this Mac or Windows PC. Aktar holds the storage keys and applies each destination's settings (path template, image conversion, link type), so you only pass files.

## Before anything

Run `aktar status --json`. If it fails:

- `command not found`: the CLI isn't installed. Ask the user to run `npm install -g @getaktar/cli` (or `brew install getaktar/tap/aktar-cli`).
- Exit code 3 / "Not connected" / "isn't running": the user needs to open Aktar, turn on Settings > Integrations > Allow local connections, and run `aktar login` themselves. Don't ask for the token in chat.
- "couldn't prove it's Aktar" or "Update to Aktar for Mac 0.18.0...": the token wasn't sent. The user needs to update Aktar, or run `aktar login` again if its token changed.

## Uploading publishes the file

Anyone with the link can open an uploaded file. Only upload what the user asked to share, never files that may hold secrets (`.env`, keys, credentials, private documents) unless they explicitly ask for that file.

## Commands

Always add `--json` when you need to read the result.

```bash
aktar upload <file>... --json            # upload; prints an array of uploads
aktar upload <file> -d "<destination>"   # to a named destination
aktar upload <file> --name cover         # under another name (extension kept)
aktar upload <file> --folder docs/2026   # keep the name, into a bucket folder
aktar upload <file> --expires 7          # delete after 1, 7, 14 or 30 days
aktar upload <file> --short              # with a short link (--no-short: without)
aktar upload --clipboard --json          # what's on the clipboard
aktar replace <upload-id|link|key> <file> --json   # new contents, same link
aktar history [search] -n 10 --json      # recent uploads, newest first
aktar short <upload-id|link> --json      # a short link for an upload, or the one it has
aktar destinations --json                # destinations ("isDefault" is the selected one)
aktar qr <link|upload-id> --png qr.png   # a QR code of a link
```

Each upload in the JSON has `url` (the link), `shortUrl` (its short link, or null), `formats.markdown` and `formats.html` (ready to paste, with the short link when there is one), `objectKey`, `id`, `expiresAt`, and `reused: true` when the same file was already uploaded and its existing link was returned. `shortLinkError` means the short link couldn't be made and the original link was used.

## Short links

Destinations with a link shortener set up in Aktar shorten links by their own rules; leave `--short` out unless the user asks for a short link. `--short` fails if the destination has no shortener. To give the user a link, prefer `shortUrl` when it isn't null.

## Choosing a destination

Leave `-d` out unless the user names one: Aktar then picks the destination whose "Use for" matches the file type, or the selected one. Destination names come from `aktar destinations --json`.

## Replacing instead of re-uploading

When the user wants to update a file that's already shared (a doc, a build, an image in a README), use `aktar replace` with the upload's ID or link from `aktar history --json`. The link stays the same; a new upload would get a new link.

## Exit codes

0 fine, 1 the upload or request failed (message on stderr), 2 wrong usage, 3 can't reach or authenticate with Aktar.

## MCP

If this agent supports MCP, the same features are available as tools with `aktar mcp --root <folder>` (see https://github.com/getaktar/cli#mcp-server).

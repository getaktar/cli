<p align="center">
  <img src="https://raw.githubusercontent.com/getaktar/cli/main/docs/logo.png" alt="Aktar" width="96" height="96">
</p>

<h1 align="center">Aktar CLI</h1>

<p align="center">
  Upload files to your own S3, Cloudflare R2 or Backblaze B2 bucket from the terminal, and get the link.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@getaktar/cli"><img src="https://img.shields.io/npm/v/@getaktar/cli?color=125efe" alt="npm version"></a>
  <a href="https://github.com/getaktar/cli/actions/workflows/ci.yml"><img src="https://github.com/getaktar/cli/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/getaktar/cli/blob/main/LICENSE"><img src="https://img.shields.io/npm/l/@getaktar/cli?color=125efe" alt="MIT license"></a>
</p>

![aktar upload in a terminal: links, Markdown and JSON output](https://raw.githubusercontent.com/getaktar/cli/main/docs/demo.png)

The `aktar` command talks to the [Aktar](https://getaktar.com) app on your Mac or Windows PC, so it uses the destinations, keys, path templates and link settings you already set up there. Your storage keys never leave the app.

```bash
$ aktar upload screenshot.png
https://files.example.com/2026/09/7f3c2a91.png
```

## Install

```bash
npm install -g @getaktar/cli
# or
brew install getaktar/tap/aktar-cli
```

Or run it without installing: `npx @getaktar/cli upload file.png`.

Requires Node.js 18 or later and Aktar for Mac 0.4.0 or later, or Aktar for Windows.

## Connect to Aktar

1. In Aktar, open **Settings > Integrations** and turn on **Allow local connections**.
2. Copy the token shown there.
3. Run:

```bash
aktar login
```

and paste the token when asked. It's checked against Aktar and saved to `~/.config/aktar/cli.json` (`%APPDATA%\aktar\cli.json` on Windows), readable only by you. You can also pipe it in (`pbpaste | aktar login`) or set `AKTAR_TOKEN` (and `AKTAR_PORT` if you changed the port) instead.

## Usage

```bash
aktar upload report.pdf                     # prints the link
aktar upload *.png -f markdown              # one Markdown image per file
aktar upload build.zip -d Builds            # pick a destination by name or ID
aktar upload notes.txt --folder docs/2026   # keep the name, upload into a folder
aktar upload log.txt --expires 7            # delete after 7 days
aktar upload --clipboard                    # the file or image on the clipboard
aktar upload photo.jpg --json               # full details as JSON

aktar status                                # which Aktar and destination you're connected to
aktar destinations                          # list destinations (* marks the selected one)
aktar history invoice -n 5                  # search recent uploads
```

Without `-d`, files go to the destination selected in Aktar's menu bar. Uploads show up in Aktar's history like any other.

`--format` chooses what's printed: `url` (default), `markdown`, `html`, or `custom` (your template from Aktar). `--expires` takes 1, 7, 14 or 30 days and needs Aktar's auto-delete rules on that destination; without it, files are kept.

### JSON output

`aktar upload --json` prints an array with one entry per uploaded file:

```json
[
  {
    "id": "0B6C…",
    "filename": "photo.jpg",
    "objectKey": "2026/09/7f3c2a91.jpg",
    "url": "https://files.example.com/2026/09/7f3c2a91.jpg",
    "destinationId": "5D1A…",
    "destinationName": "Screenshots",
    "mimeType": "image/jpeg",
    "size": 482113,
    "createdAt": "2026-09-30T12:00:00Z",
    "expiresAt": null,
    "formats": { "url": "…", "markdown": "…", "html": "…", "custom": "…" }
  }
]
```

### Exit codes

| Code | Meaning |
|---|---|
| 0 | Everything worked |
| 1 | At least one upload or request failed (the others still went through) |
| 2 | Bad arguments, or a file that doesn't exist (nothing was uploaded) |
| 3 | Not logged in, Aktar isn't running, its local API is off, or the token is wrong |

## Typora

In Typora, open **Settings > Image > Image Upload**, choose **Custom Command** and enter:

```
aktar upload
```

Typora passes the image paths and reads one link per line. Click **Test Uploader** to check it.

## Links

- Website: https://getaktar.com/cli/
- Aktar for Mac and Windows: https://getaktar.com
- Homebrew: `brew install getaktar/tap/aktar-cli`

## License

MIT

import { access, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { AktarError, Client, DEFAULT_PORT, type Destination, type OutputFormat, type Upload } from "./api.js";
import { configPath, loadConnection, parsePort, removeConnection, saveConnection } from "./config.js";
import { encodeQR, qrPNG, qrText } from "./qr.js";

export const VERSION = "0.2.0";

/** What `run` talks to, so tests can pass their own. */
export type IO = {
  stdout: NodeJS.WritableStream & { isTTY?: boolean };
  stderr: NodeJS.WritableStream & { isTTY?: boolean };
  stdin: NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (mode: boolean) => unknown };
  env: NodeJS.ProcessEnv;
};

/** Exit codes: 0 fine, 1 a request failed, 2 bad usage, 3 can't reach or authenticate with Aktar. */
const EXIT = { ok: 0, failed: 1, usage: 2, connection: 3 } as const;

class UsageError extends Error {}

const FORMATS: OutputFormat[] = ["url", "markdown", "html", "custom"];
const EXPIRY_DAYS = [0, 1, 7, 14, 30];
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const HELP = `aktar ${VERSION}: upload files to your own storage through the Aktar app

Usage:
  aktar upload <file>... [options]   Upload files and print their links
  aktar upload --clipboard           Upload the file or image on the clipboard
  aktar replace <target> <file>      Replace an upload's file and keep its link; <target> is an
                                     upload ID or link from history, or a key with -d
  aktar qr <link|text|upload-id>     Show a QR code (an upload ID from history shows its link)
  aktar login [--token <token>]      Save the token from Aktar's Settings > Integrations
  aktar logout                       Forget the saved token
  aktar status                       Check the connection to Aktar
  aktar destinations                 List destinations
  aktar history [search]             List recent uploads

Upload options:
  -d, --destination <name|id>  Destination to upload to (default: the one selected in Aktar)
  -f, --format <format>        url (default), markdown, html or custom (your template in Aktar)
      --name <name>            Upload one file under this name (keeps its extension if <name> has none)
      --folder <path>          Keep the file name and upload into this folder
      --expires <days>         Delete after 1, 7, 14 or 30 days (needs Aktar's auto-delete rules)
      --qr                     Also print a QR code of each link
      --clipboard              Upload what's on the clipboard instead of files

QR options:
      --png <file>             Save the QR code as a PNG instead of printing it

Other options:
  -n, --limit <n>              Uploads to list with history (default 20)
      --json                   Print JSON instead of text
      --port <port>            Aktar's local API port (default ${DEFAULT_PORT})
  -h, --help                   Show this help
  -v, --version                Show the version

The token and port can also come from AKTAR_TOKEN and AKTAR_PORT.
`;

export async function run(argv: string[], io: IO): Promise<number> {
  const out = (text: string) => io.stdout.write(`${text}\n`);
  const err = (text: string) => io.stderr.write(`${text}\n`);

  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        destination: { type: "string", short: "d" },
        format: { type: "string", short: "f" },
        name: { type: "string" },
        folder: { type: "string" },
        expires: { type: "string" },
        qr: { type: "boolean" },
        png: { type: "string" },
        clipboard: { type: "boolean" },
        limit: { type: "string", short: "n" },
        json: { type: "boolean" },
        token: { type: "string" },
        port: { type: "string" },
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "v" },
      },
    });
  } catch (error) {
    err(`aktar: ${(error as Error).message}`);
    err("Run aktar --help for usage.");
    return EXIT.usage;
  }
  const { values: options, positionals } = parsed;
  const [command, ...args] = positionals;

  if (options.version) {
    out(VERSION);
    return EXIT.ok;
  }
  if (options.help || !command || command === "help") {
    io.stdout.write(HELP);
    return command || options.help ? EXIT.ok : EXIT.usage;
  }

  try {
    switch (command) {
      case "upload":
        return await upload(args, options, io, out, err);
      case "replace":
        return await replace(args, options, io, out);
      case "qr":
        return await qr(args, options, io, out);
      case "login":
        return await login(options, io, out, err);
      case "logout":
        await removeConnection(io.env);
        out("Logged out.");
        return EXIT.ok;
      case "status":
        return await status(options, io, out);
      case "destinations":
        return await destinations(options, io, out);
      case "history":
        return await history(args, options, io, out);
      default:
        throw new UsageError(`Unknown command "${command}".`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      err(`aktar: ${error.message}`);
      err("Run aktar --help for usage.");
      return EXIT.usage;
    }
    if (error instanceof AktarError) {
      err(`aktar: ${error.message}`);
      if (error.kind === "unauthorized") err("The token doesn't match Aktar's anymore. Run aktar login again.");
      return error.kind === "request-failed" ? EXIT.failed : EXIT.connection;
    }
    err(`aktar: ${(error as Error).message}`);
    return EXIT.failed;
  }
}

type Options = {
  destination?: string;
  format?: string;
  name?: string;
  folder?: string;
  expires?: string;
  qr?: boolean;
  png?: string;
  clipboard?: boolean;
  limit?: string;
  json?: boolean;
  token?: string;
  port?: string;
};

class NotConnectedError extends AktarError {}

async function client(options: Options, io: IO): Promise<Client> {
  const connection = await loadConnection(io.env);
  if (!connection) {
    throw new NotConnectedError(
      "not-running",
      "Not connected to Aktar yet. Run aktar login with the token from Aktar's Settings > Integrations.",
    );
  }
  const port = parsePort(options.port);
  if (Number.isNaN(port)) throw new UsageError("--port must be a number between 1 and 65535.");
  return new Client({ ...connection, port: port ?? connection.port });
}

// MARK: - upload

async function upload(files: string[], options: Options, io: IO, out: (t: string) => void, err: (t: string) => void) {
  const format = (options.format ?? "url") as OutputFormat;
  if (!FORMATS.includes(format)) throw new UsageError(`--format must be one of ${FORMATS.join(", ")}.`);
  const expires = options.expires === undefined ? undefined : Number(options.expires);
  if (expires !== undefined && !EXPIRY_DAYS.includes(expires)) {
    throw new UsageError("--expires must be 1, 7, 14 or 30 (days), or 0 to keep the file.");
  }
  if (options.clipboard && files.length > 0) throw new UsageError("Pass files or --clipboard, not both.");
  if (!options.clipboard && files.length === 0) throw new UsageError("Name at least one file to upload, or use --clipboard.");
  if (options.folder !== undefined && expires) throw new UsageError("--folder and --expires can't be combined.");
  if (options.clipboard && options.folder !== undefined) throw new UsageError("--folder only works with files.");
  if (options.clipboard && options.name !== undefined) throw new UsageError("--name only works with files.");
  if (options.name !== undefined && files.length !== 1) throw new UsageError("--name works with one file at a time.");
  if (options.qr && options.json) throw new UsageError("--qr and --json can't be combined.");
  if (options.png !== undefined) throw new UsageError("--png only works with aktar qr.");
  const filename = options.name === undefined ? undefined : uploadName(options.name, files[0]);

  // Check the files before uploading anything, so a typo doesn't leave half a batch uploaded.
  for (const file of files) {
    await access(file).catch(() => {
      throw new UsageError(`No such file: ${file}`);
    });
  }

  const aktar = await client(options, io);
  const destinationId = options.destination ? (await findDestination(aktar, options.destination)).id : undefined;

  if (options.clipboard) {
    const uploaded = await aktar.uploadClipboard({ destinationId, expires });
    if (options.json) out(JSON.stringify([uploaded], null, 2));
    else show(uploaded, "clipboard", format, options, io, out, err);
    return EXIT.ok;
  }

  const showProgress = !options.json && Boolean(io.stderr.isTTY);
  const uploaded: Upload[] = [];
  let failures = 0;
  for (const file of files) {
    try {
      const result = await aktar.uploadFile(file, {
        filename,
        destinationId,
        prefix: options.folder,
        expires,
        onProgress: showProgress ? (fraction) => io.stderr.write(`\r${file}  ${Math.round(fraction * 100)}%`) : undefined,
      });
      if (showProgress) io.stderr.write("\r\u001b[2K");
      uploaded.push(result);
      // Print as each one finishes, so a long batch shows links as it goes.
      if (!options.json) show(result, file, format, options, io, out, err);
    } catch (error) {
      if (showProgress) io.stderr.write("\r\u001b[2K");
      // Can't reach Aktar at all: the rest would fail the same way.
      if (error instanceof AktarError && error.kind !== "request-failed") throw error;
      failures += 1;
      err(`aktar: ${file}: ${(error as Error).message}`);
    }
  }
  if (options.json) out(JSON.stringify(uploaded, null, 2));
  return failures > 0 ? EXIT.failed : EXIT.ok;
}

// MARK: - replace

/**
 * `target` is an upload ID or a link from history (replaced through that
 * entry, so history follows), or otherwise a key in the bucket of `-d` (the
 * selected destination when left out).
 */
async function replace(args: string[], options: Options, io: IO, out: (t: string) => void) {
  if (args.length !== 2 || !args[0] || !args[1]) throw new UsageError("Pass what to replace and the new file: aktar replace <target> <file>.");
  if (options.folder !== undefined || options.expires !== undefined || options.name !== undefined || options.clipboard) {
    throw new UsageError("aktar replace keeps the key, so --folder, --expires, --name and --clipboard don't apply.");
  }
  if (options.qr && options.json) throw new UsageError("--qr and --json can't be combined.");
  const format = (options.format ?? "url") as OutputFormat;
  if (!FORMATS.includes(format)) throw new UsageError(`--format must be one of ${FORMATS.join(", ")}.`);
  const [target, file] = args;
  await access(file).catch(() => {
    throw new UsageError(`No such file: ${file}`);
  });

  const aktar = await client(options, io);
  const showProgress = !options.json && Boolean(io.stderr.isTTY);
  const onProgress = showProgress ? (fraction: number) => io.stderr.write(`\r${file}  ${Math.round(fraction * 100)}%`) : undefined;
  let replaced: Upload;
  try {
    if (UPLOAD_ID.test(target) || /^https?:\/\//i.test(target)) {
      const uploads = await aktar.uploads({ limit: 1000 });
      const match = uploads.find((upload) =>
        UPLOAD_ID.test(target) ? upload.id.toLowerCase() === target.toLowerCase() : upload.url === target,
      );
      if (!match) {
        throw new UsageError(
          UPLOAD_ID.test(target)
            ? `No upload with ID ${target} in Aktar's history.`
            : `No upload with that link in Aktar's history. Pass its key with -d <destination> instead.`,
        );
      }
      replaced = await aktar.replaceUpload(match.id, file, onProgress);
    } else {
      const destinationId = options.destination
        ? (await findDestination(aktar, options.destination)).id
        : (await aktar.status()).defaultDestinationId;
      if (!destinationId) throw new UsageError("Aktar has no destination yet.");
      replaced = await aktar.replaceObject(destinationId, target.replace(/^\/+/, ""), file, onProgress);
    }
  } finally {
    if (showProgress) io.stderr.write("\r\u001b[2K");
  }
  if (options.json) out(JSON.stringify(replaced, null, 2));
  else show({ ...replaced, reused: false }, file, format, options, io, out, () => {});
  return EXIT.ok;
}

/** The name to upload `file` under: `--name` without slashes, with the file's extension unless it has one. */
function uploadName(wanted: string, file: string): string {
  const name = wanted.replace(/[/\\]/g, "").trim();
  if (!name) throw new UsageError("--name needs a name.");
  return path.extname(name) ? name : `${name}${path.extname(file)}`;
}

/** One upload in text mode: notes on stderr, so stdout stays just the links (and QR codes, if asked). */
function show(
  upload: Upload,
  label: string,
  format: OutputFormat,
  options: Options,
  io: IO,
  out: (t: string) => void,
  err: (t: string) => void,
) {
  if (upload.reused) err(`aktar: ${label}: already uploaded, reused the existing link`);
  out(upload.formats[format] ?? upload.url);
  if (!options.qr) return;
  try {
    // Always the link itself: a phone can't open Markdown or HTML.
    out(qrText(encodeQR(upload.url), { color: useColor(io) }));
  } catch (error) {
    err(`aktar: ${label}: ${(error as Error).message}`);
  }
}

const useColor = (io: IO) => Boolean(io.stdout.isTTY) && !io.env.NO_COLOR;

async function findDestination(aktar: Client, wanted: string): Promise<Destination> {
  const all = await aktar.destinations();
  const match =
    all.find((destination) => destination.id.toLowerCase() === wanted.toLowerCase()) ??
    all.find((destination) => destination.name.toLowerCase() === wanted.toLowerCase());
  if (!match) {
    const names = all.map((destination) => `"${destination.name}"`).join(", ");
    throw new UsageError(`No destination named "${wanted}". Aktar has: ${names || "none yet"}.`);
  }
  return match;
}

// MARK: - qr

async function qr(args: string[], options: Options, io: IO, out: (t: string) => void) {
  if (args.length !== 1 || !args[0]) throw new UsageError("Pass one link, text or upload ID to aktar qr (quote text with spaces).");
  if (options.png !== undefined && !options.png.trim()) throw new UsageError("--png needs a file name.");
  let text = args[0];
  if (UPLOAD_ID.test(text)) {
    // Looks like an upload ID: show that upload's link.
    const uploads = await (await client(options, io)).uploads({ limit: 1000 });
    const match = uploads.find((upload) => upload.id.toLowerCase() === text.toLowerCase());
    if (!match) throw new Error(`No upload with ID ${text} in Aktar's history.`);
    text = match.url;
    if (options.png === undefined) out(text);
  }
  const code = encodeQR(text);
  if (options.png !== undefined) {
    await writeFile(options.png, qrPNG(code));
    out(`Saved to ${options.png}`);
  } else {
    out(qrText(code, { color: useColor(io) }));
  }
  return EXIT.ok;
}

// MARK: - login

async function login(options: Options, io: IO, out: (t: string) => void, err: (t: string) => void) {
  const port = parsePort(options.port);
  if (Number.isNaN(port)) throw new UsageError("--port must be a number between 1 and 65535.");
  let token = options.token?.trim();
  if (!token) {
    if (io.stdin.isTTY) {
      err("Copy the token from Aktar: Settings > Integrations (turn on Allow local connections first).");
      token = (await promptHidden("Token: ", io)).trim();
    } else {
      token = (await readAll(io.stdin)).trim();
    }
  }
  if (!token) throw new UsageError("No token given.");

  const connection = { token, port: port ?? DEFAULT_PORT };
  // Check it before saving, so a typo doesn't get stored.
  const info = await new Client(connection).status();
  const file = await saveConnection(connection, io.env);
  out(`Connected to ${info.app} ${info.version}. Saved to ${file}`);
  return EXIT.ok;
}

function promptHidden(question: string, io: IO): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: io.stdin, output: io.stderr, terminal: true });
    // Keep the token off the screen: print the question, swallow the echo.
    const output = rl as unknown as { _writeToOutput: (text: string) => void };
    io.stderr.write(question);
    output._writeToOutput = () => {};
    rl.question("", (answer) => {
      rl.close();
      io.stderr.write("\n");
      resolve(answer);
    });
  });
}

async function readAll(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

// MARK: - status, destinations, history

async function status(options: Options, io: IO, out: (t: string) => void) {
  const aktar = await client(options, io);
  const [info, all] = await Promise.all([aktar.status(), aktar.destinations()]);
  if (options.json) {
    out(JSON.stringify({ ...info, port: aktar.connection.port }, null, 2));
    return EXIT.ok;
  }
  const selected = all.find((destination) => destination.id === info.defaultDestinationId);
  out(`${info.app} ${info.version} (build ${info.build}) on port ${aktar.connection.port}`);
  out(`Destination: ${selected ? `${selected.name} (${selected.providerName}, ${selected.bucket})` : "none"}`);
  out(`Config: ${configPath(io.env)}`);
  return EXIT.ok;
}

async function destinations(options: Options, io: IO, out: (t: string) => void) {
  const all = await (await client(options, io)).destinations();
  if (options.json) {
    out(JSON.stringify(all, null, 2));
    return EXIT.ok;
  }
  if (all.length === 0) out("No destinations yet. Add one in Aktar's Settings.");
  for (const destination of all) {
    out(`${destination.isDefault ? "*" : " "} ${destination.name}  ${destination.providerName}  ${destination.bucket}  ${destination.id}`);
  }
  return EXIT.ok;
}

async function history(args: string[], options: Options, io: IO, out: (t: string) => void) {
  const limit = options.limit === undefined ? 20 : Number(options.limit);
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError("--limit must be a positive number.");
  const aktar = await client(options, io);
  const destinationId = options.destination ? (await findDestination(aktar, options.destination)).id : undefined;
  const uploads = await aktar.uploads({ query: args.join(" ") || undefined, destinationId, limit });
  if (options.json) {
    out(JSON.stringify(uploads, null, 2));
    return EXIT.ok;
  }
  if (uploads.length === 0) out("No uploads found.");
  for (const upload of uploads) out(`${upload.createdAt.slice(0, 10)}  ${upload.filename}  ${upload.url}`);
  return EXIT.ok;
}

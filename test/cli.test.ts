import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, before, describe, test } from "node:test";
import { run, type IO } from "../src/run.js";

// A stand-in for Aktar's local API: the same routes, auth and error shapes.
const TOKEN = "test-token";
const destinations = [
  { id: "D1", name: "Screenshots", provider: "cloudflareR2", providerName: "Cloudflare R2", bucket: "shots", publicBaseURL: "https://shots.example.com", isDefault: true },
  { id: "D2", name: "Builds", provider: "amazonS3", providerName: "Amazon S3", bucket: "builds", publicBaseURL: "https://builds.example.com", isDefault: false },
];
const received: { url: string; bytes: number }[] = [];
const OLD_ID = "0B6C2F8E-3D1A-4C55-9E2B-7A41D0C3E9F1";

function uploadFor(filename: string, destinationId = "D1") {
  const url = `https://shots.example.com/2026/09/${filename}`;
  return {
    id: `U-${filename}`,
    filename,
    objectKey: `2026/09/${filename}`,
    url,
    destinationId,
    destinationName: destinationId === "D1" ? "Screenshots" : "Builds",
    mimeType: "image/png",
    size: 3,
    createdAt: "2026-09-30T12:00:00Z",
    expiresAt: null,
    formats: { url, markdown: `![${filename}](${url})`, html: `<img src="${url}" alt="">`, custom: `[${filename}](${url})` },
  };
}

const server = http.createServer((req, res) => {
  const send = (status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const chunks: Buffer[] = [];
  req.on("data", (chunk: Buffer) => chunks.push(chunk));
  req.on("end", () => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { error: "Missing or invalid API token." });
    const url = new URL(req.url ?? "/", "http://localhost");
    received.push({ url: req.url ?? "", bytes: Buffer.concat(chunks).length });
    if (req.method === "GET" && url.pathname === "/v1/status") {
      return send(200, { app: "Aktar", version: "0.7.0", build: "10", apiVersion: 1, defaultDestinationId: "D1", outputFormat: "url" });
    }
    if (req.method === "GET" && url.pathname === "/v1/destinations") return send(200, { destinations });
    if (req.method === "GET" && url.pathname === "/v1/uploads") return send(200, { uploads: [{ ...uploadFor("old.png"), id: OLD_ID }] });
    if (req.method === "POST" && url.pathname === "/v1/uploads") {
      const filename = url.searchParams.get("filename") ?? "";
      if (filename === "broken.png") return send(502, { error: "The bucket said no." });
      const upload = uploadFor(filename, url.searchParams.get("destinationId") ?? "D1");
      // The Mac says `reused` in the upload, Windows next to it.
      if (filename === "same.png") return send(201, { upload: { ...upload, reused: true } });
      if (filename === "again.png") return send(201, { upload, reused: true });
      return send(201, { upload: { ...upload, reused: false } });
    }
    if (req.method === "POST" && url.pathname === "/v1/uploads/clipboard") return send(201, { upload: uploadFor("clipboard.png") });
    send(404, { error: "Not found." });
  });
});

let port = 0;
let dir = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  dir = await mkdtemp(path.join(os.tmpdir(), "aktar-cli-"));
  await writeFile(path.join(dir, "a.png"), "abc");
  await writeFile(path.join(dir, "b.png"), "abc");
  await writeFile(path.join(dir, "broken.png"), "abc");
  await writeFile(path.join(dir, "same.png"), "abc");
  await writeFile(path.join(dir, "again.png"), "abc");
});

after(() => server.close());

/** Runs the CLI with its own config folder and captures what it prints. */
async function cli(args: string[], env: NodeJS.ProcessEnv = {}, stdinText?: string, tty = false) {
  const stdout = Object.assign(new PassThrough(), { isTTY: tty });
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  let outText = "";
  let errText = "";
  stdout.on("data", (chunk) => (outText += chunk));
  stderr.on("data", (chunk) => (errText += chunk));
  if (stdinText !== undefined) stdin.end(stdinText);
  const io: IO = { stdout, stderr, stdin, env: { XDG_CONFIG_HOME: path.join(dir, "config"), APPDATA: path.join(dir, "config"), ...env } };
  const code = await run(args, io);
  return { code, out: outText, err: errText };
}

const loggedIn = () => ({ AKTAR_TOKEN: TOKEN, AKTAR_PORT: String(port) });

describe("upload", () => {
  test("prints one link per file", async () => {
    const result = await cli(["upload", path.join(dir, "a.png"), path.join(dir, "b.png")], loggedIn());
    assert.equal(result.code, 0);
    assert.equal(result.out, "https://shots.example.com/2026/09/a.png\nhttps://shots.example.com/2026/09/b.png\n");
  });

  test("sends the file bytes and options", async () => {
    received.length = 0;
    await cli(["upload", path.join(dir, "a.png"), "-d", "builds", "--expires", "7"], loggedIn());
    const upload = received.find((request) => request.url.startsWith("/v1/uploads?"));
    assert.ok(upload);
    assert.equal(upload.bytes, 3);
    const query = new URL(upload.url, "http://x").searchParams;
    assert.equal(query.get("filename"), "a.png");
    assert.equal(query.get("destinationId"), "D2");
    assert.equal(query.get("expires"), "7");
  });

  test("--json prints the uploads", async () => {
    const result = await cli(["upload", path.join(dir, "a.png"), "--json"], loggedIn());
    assert.equal(result.code, 0);
    const uploads = JSON.parse(result.out);
    assert.equal(uploads.length, 1);
    assert.equal(uploads[0].url, "https://shots.example.com/2026/09/a.png");
    assert.equal(uploads[0].formats.markdown, "![a.png](https://shots.example.com/2026/09/a.png)");
  });

  test("--format picks a copy format", async () => {
    const result = await cli(["upload", path.join(dir, "a.png"), "-f", "markdown"], loggedIn());
    assert.equal(result.out, "![a.png](https://shots.example.com/2026/09/a.png)\n");
  });

  test("keeps going after a failed file and exits 1", async () => {
    const result = await cli(["upload", path.join(dir, "broken.png"), path.join(dir, "a.png")], loggedIn());
    assert.equal(result.code, 1);
    assert.equal(result.out, "https://shots.example.com/2026/09/a.png\n");
    assert.match(result.err, /broken\.png: The bucket said no\./);
  });

  test("--clipboard uploads the clipboard", async () => {
    const result = await cli(["upload", "--clipboard"], loggedIn());
    assert.equal(result.out, "https://shots.example.com/2026/09/clipboard.png\n");
  });

  test("checks every file before uploading any", async () => {
    received.length = 0;
    const result = await cli(["upload", path.join(dir, "a.png"), path.join(dir, "missing.png")], loggedIn());
    assert.equal(result.code, 2);
    assert.match(result.err, /No such file/);
    assert.equal(received.length, 0);
  });

  test("rejects bad options", async () => {
    assert.equal((await cli(["upload", path.join(dir, "a.png"), "--expires", "3"], loggedIn())).code, 2);
    assert.equal((await cli(["upload", path.join(dir, "a.png"), "-f", "pdf"], loggedIn())).code, 2);
    assert.equal((await cli(["upload"], loggedIn())).code, 2);
    const unknown = await cli(["upload", path.join(dir, "a.png"), "-d", "nope"], loggedIn());
    assert.equal(unknown.code, 2);
    assert.match(unknown.err, /"Screenshots", "Builds"/);
  });
});

describe("--name", () => {
  const sentName = async (args: string[]) => {
    received.length = 0;
    const result = await cli(["upload", path.join(dir, "a.png"), ...args], loggedIn());
    assert.equal(result.code, 0, result.err);
    const upload = received.find((request) => request.url.startsWith("/v1/uploads?"));
    assert.ok(upload);
    return new URL(upload.url, "http://x").searchParams;
  };

  test("sends the new name, with the file's extension if it has none", async () => {
    assert.equal((await sentName(["--name", "diagram"])).get("filename"), "diagram.png");
    assert.equal((await sentName(["--name", "diagram.webp"])).get("filename"), "diagram.webp");
    assert.equal((await sentName(["--name", " my/team\\shot "])).get("filename"), "myteamshot.png");
  });

  test("works with --folder", async () => {
    const query = await sentName(["--name", "cover", "--folder", "docs/2026"]);
    assert.equal(query.get("filename"), "cover.png");
    assert.equal(query.get("prefix"), "docs/2026");
  });

  test("needs exactly one file and a name", async () => {
    received.length = 0;
    const two = await cli(["upload", path.join(dir, "a.png"), path.join(dir, "b.png"), "--name", "x"], loggedIn());
    assert.equal(two.code, 2);
    assert.match(two.err, /one file at a time/);
    assert.equal((await cli(["upload", "--clipboard", "--name", "x"], loggedIn())).code, 2);
    assert.equal((await cli(["upload", path.join(dir, "a.png"), "--name", " / "], loggedIn())).code, 2);
    assert.equal((await cli(["upload", path.join(dir, "a.png"), "--name", ""], loggedIn())).code, 2);
    assert.equal(received.length, 0);
  });
});

describe("reused uploads", () => {
  test("say so on stderr and keep stdout to the links", async () => {
    const result = await cli(["upload", path.join(dir, "same.png"), path.join(dir, "again.png"), path.join(dir, "a.png")], loggedIn());
    assert.equal(result.code, 0);
    assert.equal(
      result.out,
      "https://shots.example.com/2026/09/same.png\nhttps://shots.example.com/2026/09/again.png\nhttps://shots.example.com/2026/09/a.png\n",
    );
    const notes = result.err.trim().split("\n");
    assert.equal(notes.length, 2);
    assert.equal(notes[0], `aktar: ${path.join(dir, "same.png")}: already uploaded, reused the existing link`);
    assert.match(notes[1], /again\.png: already uploaded, reused the existing link$/);
  });

  test("--json has reused, from either place", async () => {
    const result = await cli(["upload", path.join(dir, "same.png"), path.join(dir, "again.png"), path.join(dir, "a.png"), "--json"], loggedIn());
    assert.equal(result.err, "");
    assert.deepEqual(
      JSON.parse(result.out).map((upload: { reused?: boolean }) => upload.reused),
      [true, true, false],
    );
  });
});

describe("QR codes", () => {
  const blocks = /[\u2580\u2584\u2588]{29}/;

  test("--qr prints a QR code of the link under each one", async () => {
    const result = await cli(["upload", path.join(dir, "a.png"), path.join(dir, "b.png"), "--qr", "-f", "markdown"], loggedIn());
    assert.equal(result.code, 0);
    const lines = result.out.trimEnd().split("\n");
    assert.equal(lines[0], "![a.png](https://shots.example.com/2026/09/a.png)");
    assert.match(lines[1], blocks);
    const second = lines.indexOf("![b.png](https://shots.example.com/2026/09/b.png)");
    assert.ok(second > 1);
    assert.match(lines[second + 1], blocks);
    // Piped: no color codes.
    assert.doesNotMatch(result.out, /\u001b/);
  });

  test("--qr draws with color on a terminal, unless NO_COLOR", async () => {
    const file = path.join(dir, "a.png");
    assert.match((await cli(["upload", file, "--qr"], loggedIn(), undefined, true)).out, /\u001b\[38;5;16;48;5;231m/);
    assert.doesNotMatch((await cli(["upload", file, "--qr"], { ...loggedIn(), NO_COLOR: "1" }, undefined, true)).out, /\u001b/);
    assert.doesNotMatch((await cli(["upload", file], loggedIn(), undefined, true)).out, blocks);
  });

  test("--qr doesn't go with --json", async () => {
    assert.equal((await cli(["upload", path.join(dir, "a.png"), "--qr", "--json"], loggedIn())).code, 2);
  });

  test("aktar qr prints a QR code of the text, without Aktar", async () => {
    const result = await cli(["qr", "https://getaktar.com"]);
    assert.equal(result.code, 0);
    const lines = result.out.trimEnd().split("\n");
    // Version 2: 25 modules plus 4 on each side, two per line.
    assert.equal(lines.length, 17);
    assert.ok(lines.every((line) => [...line].length === 33));
  });

  test("aktar qr with an upload ID shows that upload's link", async () => {
    const result = await cli(["qr", OLD_ID.toLowerCase()], loggedIn());
    assert.equal(result.code, 0);
    const [link, ...code] = result.out.trimEnd().split("\n");
    assert.equal(link, "https://shots.example.com/2026/09/old.png");
    assert.match(code[0], blocks);

    const missing = await cli(["qr", "11111111-2222-3333-4444-555555555555"], loggedIn());
    assert.equal(missing.code, 1);
    assert.match(missing.err, /No upload with ID/);
  });

  test("aktar qr --png saves a PNG", async () => {
    const file = path.join(dir, "link.png");
    const result = await cli(["qr", "https://getaktar.com", "--png", file]);
    assert.equal(result.code, 0);
    assert.equal(result.out, `Saved to ${file}\n`);
    const png = await readFile(file);
    assert.equal(png.subarray(1, 4).toString(), "PNG");
    assert.equal(png.readUInt32BE(16), 33 * 16);
  });

  test("aktar qr needs one argument", async () => {
    assert.equal((await cli(["qr"])).code, 2);
    assert.equal((await cli(["qr", "a", "b"])).code, 2);
    assert.equal((await cli(["upload", path.join(dir, "a.png"), "--png", "x.png"], loggedIn())).code, 2);
  });
});

describe("connection", () => {
  test("says how to log in when there's no token", async () => {
    const result = await cli(["upload", path.join(dir, "a.png")]);
    assert.equal(result.code, 3);
    assert.match(result.err, /aktar login/);
  });

  test("a wrong token exits 3", async () => {
    const result = await cli(["status"], { AKTAR_TOKEN: "wrong", AKTAR_PORT: String(port) });
    assert.equal(result.code, 3);
    assert.match(result.err, /Run aktar login again/);
  });

  test("Aktar not running exits 3", async () => {
    const result = await cli(["status"], { AKTAR_TOKEN: TOKEN, AKTAR_PORT: "1" });
    assert.equal(result.code, 3);
    assert.match(result.err, /isn't running/);
  });

  test("login checks the token and saves it for later", async () => {
    const env = { XDG_CONFIG_HOME: path.join(dir, "login"), APPDATA: path.join(dir, "login") };
    const bad = await cli(["login", "--port", String(port)], env, "wrong\n");
    assert.equal(bad.code, 3);

    const good = await cli(["login", "--port", String(port)], env, `${TOKEN}\n`);
    assert.equal(good.code, 0);
    assert.match(good.out, /Connected to Aktar 0\.7\.0/);
    const file = process.platform === "win32" ? path.join(dir, "login", "aktar", "cli.json") : path.join(dir, "login", "aktar", "cli.json");
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), { token: TOKEN, port });
    if (process.platform !== "win32") assert.equal((await stat(file)).mode & 0o777, 0o600);

    const status = await cli(["status"], env);
    assert.equal(status.code, 0);
    assert.match(status.out, /Destination: Screenshots \(Cloudflare R2, shots\)/);

    assert.equal((await cli(["logout"], env)).code, 0);
    assert.equal((await cli(["status"], env)).code, 3);
  });
});

describe("listing", () => {
  test("destinations marks the selected one", async () => {
    const result = await cli(["destinations"], loggedIn());
    assert.match(result.out, /^\* Screenshots/m);
    assert.match(result.out, /^ {2}Builds/m);
  });

  test("history lists uploads", async () => {
    const result = await cli(["history", "old"], loggedIn());
    assert.match(result.out, /2026-09-30 {2}old\.png {2}https:\/\/shots\.example\.com\/2026\/09\/old\.png/);
  });

  test("--help and --version", async () => {
    assert.match((await cli(["--help"])).out, /aktar upload <file>/);
    assert.equal((await cli(["--version"])).out, "0.2.0\n");
    assert.equal((await cli([])).code, 2);
  });
});

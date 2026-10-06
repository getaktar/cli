import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { after, before, describe, test } from "node:test";
import { run, VERSION, type IO } from "../src/run.js";

// A stand-in for Aktar's local API, with just what the MCP tools call.
const TOKEN = "test-token";
const UPLOAD_ID = "0B6C2F8E-3D1A-4C55-9E2B-7A41D0C3E9F1";
const SHORT_URL = "https://s.example.com/x7Kp2";
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const received: { method: string; url: string; body: string }[] = [];

const upload = (filename: string) => ({
  id: UPLOAD_ID,
  filename,
  objectKey: `2026/10/${filename}`,
  url: `https://files.example.com/2026/10/${filename}`,
  destinationId: "D1",
  destinationName: "Files",
  mimeType: "text/plain",
  size: 3,
  createdAt: "2026-10-06T12:00:00Z",
  expiresAt: null,
  formats: { url: "u", markdown: "m", html: "h", custom: "c" },
});

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
    received.push({ method: req.method ?? "", url: req.url ?? "", body: Buffer.concat(chunks).toString("utf8") });
    const route = `${req.method} ${url.pathname}`;
    switch (route) {
      case "GET /v1/status":
        return send(200, { app: "Aktar", version: "0.15.0", build: "21", apiVersion: 1, defaultDestinationId: "D1", outputFormat: "url" });
      case "GET /v1/destinations":
        return send(200, {
          destinations: [
            { id: "D1", name: "Files", provider: "cloudflareR2", providerName: "Cloudflare R2", bucket: "files", publicBaseURL: "https://files.example.com", isDefault: true },
            { id: "D2", name: "Builds", provider: "amazonS3", providerName: "Amazon S3", bucket: "builds", publicBaseURL: "https://builds.example.com", isDefault: false },
          ],
        });
      case "GET /v1/uploads":
        return send(200, { uploads: [upload("notes.txt"), { ...upload("linked.txt"), id: "6F1E0D2C-8B7A-4E3D-9C1B-0A2F4E6D8C1A", shortUrl: SHORT_URL }] });
      case "POST /v1/uploads":
        return send(201, { upload: { ...upload(url.searchParams.get("filename") ?? ""), reused: false } });
      case `POST /v1/uploads/${UPLOAD_ID}/short-link`: {
        const target = upload("notes.txt");
        return send(201, {
          shortLink: { id: "L1", shortUrl: SHORT_URL, targetUrl: target.url, provider: "shlink", providerName: "Shlink", status: "active", createdAt: "2026-10-06T12:00:00Z", expiresAt: null, clicks: null, lastClickAt: null },
          upload: { ...target, shortUrl: SHORT_URL },
        });
      }
      case `POST /v1/uploads/${UPLOAD_ID}/replace`:
        return send(200, { upload: upload("notes.txt") });
      case `DELETE /v1/uploads/${UPLOAD_ID}`:
        return send(200, { deleted: UPLOAD_ID });
      case `GET /v1/uploads/${UPLOAD_ID}/thumbnail`:
        res.writeHead(200, { "Content-Type": "image/png" });
        return res.end(PNG);
      case "GET /v1/destinations/D1/objects":
        return send(200, { prefix: url.searchParams.get("prefix") ?? "", folders: [], objects: [{ key: "a.txt", name: "a.txt", size: 3 }] });
      case "POST /v1/destinations/D2/links":
        return send(200, { url: "https://signed.example.com/a.txt?X-Amz-Signature=1", expiresAt: "2026-10-06T13:00:00Z" });
      case "GET /v1/watched-folders":
        return send(200, { paused: false, pausedUntil: null, folders: [] });
      default:
        return send(404, { error: "Not found." });
    }
  });
});

let port = 0;
let dir = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
  dir = await mkdtemp(path.join(os.tmpdir(), "aktar-mcp-"));
  await mkdir(path.join(dir, "shared"));
  await writeFile(path.join(dir, "shared", "notes.txt"), "abc");
  await writeFile(path.join(dir, "secret.env"), "KEY=1");
  await symlink(path.join(dir, "secret.env"), path.join(dir, "shared", "link.env"));
});

after(() => server.close());

/** Starts `aktar mcp`, sends each message as a line, and returns the replies by ID once stdin closes. */
async function mcp(messages: (object | string)[], args: string[] = [], env: NodeJS.ProcessEnv = { AKTAR_TOKEN: TOKEN, AKTAR_PORT: String(port) }) {
  const stdout = new PassThrough();
  const stdin = new PassThrough();
  let outText = "";
  stdout.on("data", (chunk) => (outText += chunk));
  const io: IO = { stdout, stderr: new PassThrough(), stdin, env: { XDG_CONFIG_HOME: path.join(dir, "config"), APPDATA: path.join(dir, "config"), ...env } };
  for (const message of messages) stdin.write(`${typeof message === "string" ? message : JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  stdin.end();
  const code = await run(["mcp", ...args], io);
  const lines = outText.split("\n").filter(Boolean);
  for (const line of lines) assert.equal(JSON.parse(line).jsonrpc, "2.0");
  const replies = new Map<unknown, { result?: any; error?: any }>(lines.map((line) => [JSON.parse(line).id, JSON.parse(line)]));
  return { code, replies, lines };
}

const callTool = (id: number, name: string, args: object = {}) => ({ id, method: "tools/call", params: { name, arguments: args } });

async function toolResult(name: string, args: object = {}, flags: string[] = []) {
  const { replies } = await mcp([callTool(1, name, args)], flags);
  return replies.get(1)!.result;
}

describe("protocol", () => {
  test("initialize negotiates a version and names the server", async () => {
    const { replies } = await mcp([
      { id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } },
      { method: "notifications/initialized" },
      { id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } },
      { id: 3, method: "ping" },
    ]);
    assert.equal(replies.get(1)!.result.protocolVersion, "2025-06-18");
    assert.deepEqual(replies.get(1)!.result.serverInfo, { name: "aktar", title: "Aktar", version: VERSION });
    assert.ok(replies.get(1)!.result.capabilities.tools);
    assert.match(replies.get(1)!.result.instructions, /publishes/);
    assert.equal(replies.get(2)!.result.protocolVersion, "2025-11-25");
    assert.deepEqual(replies.get(3)!.result, {});
    assert.equal(replies.size, 3, "notifications get no reply");
  });

  test("speaks the per-request era too", async () => {
    const meta = { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } };
    const { replies } = await mcp([
      { id: 1, method: "server/discover", params: meta },
      { id: 2, method: "tools/list", params: meta },
      { id: 3, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "1900-01-01" } } },
    ]);
    assert.equal(replies.get(1)!.result.resultType, "complete");
    assert.ok(replies.get(1)!.result.supportedVersions.includes("2026-07-28"));
    assert.equal(replies.get(2)!.result.resultType, "complete");
    for (const id of [1, 2]) {
      assert.equal(typeof replies.get(id)!.result.ttlMs, "number");
      assert.equal(replies.get(id)!.result.cacheScope, "public");
    }
    assert.equal(replies.get(3)!.error.code, -32022);
    assert.equal(replies.get(3)!.error.data.requested, "1900-01-01");
  });

  test("answers bad input with JSON-RPC errors and keeps going", async () => {
    const { replies, lines } = await mcp(["not json", { id: 1, method: "nope" }, callTool(2, "nope"), { id: 3, method: "ping" }]);
    assert.equal(JSON.parse(lines[0]).error.code, -32700);
    assert.equal(replies.get(1)!.error.code, -32601);
    assert.equal(replies.get(2)!.error.code, -32602);
    assert.deepEqual(replies.get(3)!.result, {});
  });
});

describe("tools/list", () => {
  const names = async (flags: string[] = []) =>
    (await mcp([{ id: 1, method: "tools/list" }], flags)).replies.get(1)!.result.tools.map((tool: { name: string }) => tool.name);

  test("offers every tool but delete by default, with schemas and hints", async () => {
    const { replies } = await mcp([{ id: 1, method: "tools/list" }]);
    const tools = replies.get(1)!.result.tools;
    assert.deepEqual(
      tools.map((tool: { name: string }) => tool.name),
      ["get_status", "list_destinations", "search_uploads", "upload_file", "upload_clipboard", "replace_file", "create_short_link", "list_bucket", "create_temporary_link", "get_thumbnail", "list_watched_folders"],
    );
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
    }
    assert.equal(tools.find((tool: { name: string }) => tool.name === "replace_file").annotations.destructiveHint, true);
  });

  test("--read-only leaves out what writes, --allow-delete adds delete_upload", async () => {
    const readOnly = await names(["--read-only"]);
    assert.ok(!readOnly.includes("upload_file") && !readOnly.includes("replace_file") && !readOnly.includes("upload_clipboard"));
    assert.ok(!readOnly.includes("create_short_link"));
    assert.ok(readOnly.includes("search_uploads"));
    assert.ok((await names(["--allow-delete"])).includes("delete_upload"));
  });

  test("rejects --read-only with --allow-delete", async () => {
    assert.equal((await mcp([], ["--read-only", "--allow-delete"])).code, 2);
  });
});

describe("tools/call", () => {
  test("upload_file uploads and returns the upload", async () => {
    received.length = 0;
    const result = await toolResult("upload_file", { path: path.join(dir, "shared", "notes.txt"), destination: "builds", name: "readme" });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.upload.filename, "readme.txt");
    assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
    const sent = received.find((request) => request.method === "POST");
    assert.ok(sent);
    assert.equal(sent.body, "abc");
    assert.equal(new URL(sent.url, "http://x").searchParams.get("destinationId"), "D2");
  });

  test("upload_file passes short, and its result always has shortUrl", async () => {
    const file = path.join(dir, "shared", "notes.txt");
    const sentShort = async (args: object) => {
      received.length = 0;
      const result = await toolResult("upload_file", { path: file, ...args });
      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent.upload.shortUrl, null);
      const sent = received.find((request) => request.method === "POST");
      assert.ok(sent);
      return new URL(sent.url, "http://x").searchParams.get("short");
    };
    assert.equal(await sentShort({ short: true }), "1");
    assert.equal(await sentShort({ short: false }), "0");
    assert.equal(await sentShort({}), null);
    assert.match((await toolResult("upload_file", { path: file, short: "yes" })).content[0].text, /short must be true or false/);
  });

  test("--root keeps uploads inside its folders, symlinks included", async () => {
    const root = ["--root", path.join(dir, "shared")];
    assert.equal((await toolResult("upload_file", { path: path.join(dir, "shared", "notes.txt") }, root)).isError, undefined);
    const outside = await toolResult("upload_file", { path: path.join(dir, "secret.env") }, root);
    assert.equal(outside.isError, true);
    assert.match(outside.content[0].text, /outside the folders/);
    assert.equal((await toolResult("upload_file", { path: path.join(dir, "shared", "link.env") }, root)).isError, true);
  });

  test("failures are tool errors the agent can read", async () => {
    const missing = await toolResult("upload_file", { path: path.join(dir, "nope.txt") });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /No such file/);
    const folder = await toolResult("upload_file", { path: dir });
    assert.match(folder.content[0].text, /Not a file/);
    const badDestination = await toolResult("upload_file", { path: path.join(dir, "shared", "notes.txt"), destination: "Photos" });
    assert.match(badDestination.content[0].text, /Aktar has: "Files", "Builds"/);
    const badExpiry = await toolResult("upload_file", { path: path.join(dir, "shared", "notes.txt"), expires: 3 });
    assert.match(badExpiry.content[0].text, /expires/);
    assert.match((await toolResult("upload_file", {})).content[0].text, /path is required/);
  });

  test("says how to connect when there's no token", async () => {
    const { replies } = await mcp([callTool(1, "get_status")], [], {});
    assert.equal(replies.get(1)!.result.isError, true);
    assert.match(replies.get(1)!.result.content[0].text, /aktar login/);
  });

  test("get_status names the selected destination", async () => {
    const result = await toolResult("get_status");
    assert.equal(result.structuredContent.selectedDestination, "Files");
  });

  test("search_uploads returns short entries", async () => {
    const result = await toolResult("search_uploads", { query: "notes", limit: 5 });
    assert.equal(result.structuredContent.uploads[0].url, "https://files.example.com/2026/10/notes.txt");
    assert.equal(result.structuredContent.uploads[0].formats, undefined);
    assert.equal(result.structuredContent.uploads[0].shortUrl, null);
    assert.equal(result.structuredContent.uploads[1].shortUrl, SHORT_URL);
  });

  test("create_short_link returns the short link and the upload", async () => {
    const result = await toolResult("create_short_link", { id: UPLOAD_ID });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.shortLink.shortUrl, SHORT_URL);
    assert.equal(result.structuredContent.upload.shortUrl, SHORT_URL);
    assert.match((await toolResult("create_short_link", { id: "nope" })).content[0].text, /upload ID/);
  });

  test("replace_file finds the upload by link", async () => {
    received.length = 0;
    const result = await toolResult("replace_file", {
      target: "https://files.example.com/2026/10/notes.txt",
      path: path.join(dir, "shared", "notes.txt"),
    });
    assert.equal(result.isError, undefined);
    assert.ok(received.some((request) => request.url === `/v1/uploads/${UPLOAD_ID}/replace`));
  });

  test("list_bucket and create_temporary_link", async () => {
    const listing = await toolResult("list_bucket", { prefix: "docs/" });
    assert.equal(listing.structuredContent.objects[0].key, "a.txt");
    received.length = 0;
    const link = await toolResult("create_temporary_link", { key: "a.txt", destination: "Builds", minutes: 30 });
    assert.match(link.structuredContent.url, /X-Amz-Signature/);
    assert.deepEqual(JSON.parse(received[received.length - 1].body), { key: "a.txt", expiresIn: 1800 });
  });

  test("get_thumbnail returns an image", async () => {
    const result = await toolResult("get_thumbnail", { id: UPLOAD_ID });
    assert.deepEqual(result.content, [{ type: "image", data: PNG.toString("base64"), mimeType: "image/png" }]);
  });

  test("delete_upload only with --allow-delete", async () => {
    const { replies } = await mcp([callTool(1, "delete_upload", { id: UPLOAD_ID })]);
    assert.equal(replies.get(1)!.error.code, -32602);
    const allowed = await toolResult("delete_upload", { id: UPLOAD_ID }, ["--allow-delete"]);
    assert.equal(allowed.structuredContent.deleted, UPLOAD_ID);
  });

  test("an Aktar without the route says to update", async () => {
    // The stand-in only lists D1's bucket, like an older app missing a route.
    const result = await toolResult("list_bucket", { destination: "Builds" });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Update Aktar/);
  });
});

describe("skill", () => {
  test("aktar skill prints SKILL.md", async () => {
    const stdout = new PassThrough();
    let text = "";
    stdout.on("data", (chunk) => (text += chunk));
    const code = await run(["skill"], { stdout, stderr: new PassThrough(), stdin: new PassThrough(), env: {} });
    assert.equal(code, 0);
    assert.match(text, /^---\r?\nname: aktar\r?\n/);
  });
});

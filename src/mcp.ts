import { realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { AktarError, Client, type Destination, type Upload } from "./api.js";
import { loadConnection } from "./config.js";

// `aktar mcp`: a Model Context Protocol server on stdin/stdout, so AI
// agents (Claude, Cursor, VS Code, Codex...) can upload through Aktar and
// find what was uploaded. It's a thin layer over the same local API the
// commands use; the storage keys stay in the app.
//
// Messages are newline-delimited JSON-RPC. Both protocol eras are served:
// clients that start with `initialize` (2024-11-05 to 2025-11-25), and
// those that send the version in each request's `_meta` (2026-07-28).

const MODERN_VERSIONS = ["2026-07-28"];
const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const VERSION_META = "io.modelcontextprotocol/protocolVersion";

/**
 * Lists only change when the server restarts with other flags, so clients
 * may keep them for an hour. Nothing in them depends on the user.
 */
const CACHE = { ttlMs: 3_600_000, cacheScope: "public" };

const ERROR = { parse: -32700, invalidRequest: -32600, methodNotFound: -32601, invalidParams: -32602, unsupportedVersion: -32022 };

export type MCPOptions = {
  version: string;
  /** Overrides the saved port, like --port on the other commands. */
  port?: number;
  /** Folders files may be uploaded from; empty allows any file the user can read. */
  roots: string[];
  /** Only the tools that change nothing. */
  readOnly: boolean;
  /** Adds delete_upload, which removes a file from its bucket. */
  allowDelete: boolean;
};

type IO = {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  env: NodeJS.ProcessEnv;
};

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
type ToolResult = { content: Content[]; structuredContent?: Record<string, unknown>; isError?: boolean };
type Args = Record<string, unknown>;

type Tool = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run: (args: Args, context: Context) => Promise<ToolResult>;
};

type Context = { client: () => Promise<Client>; options: MCPOptions };

/** A problem with what the agent asked for, shown to it as a failed tool call. */
class ToolError extends Error {}

const INSTRUCTIONS = `Aktar uploads files to the user's own S3-compatible storage (Cloudflare R2, Amazon S3, Backblaze B2, MinIO...) through the Aktar app on this computer, and returns links.
- Uploading publishes a file: anyone with its link can open it, unless the destination copies temporary links. Only upload files the user asked to share.
- Leave destination out unless the user names one: Aktar then picks it by file type (each destination's "Use for"), or uses the selected one.
- An upload's result has the link in url, and ready-made Markdown and HTML in formats.
- To change a file someone already has the link to, use replace_file instead of uploading again.`;

const destinationProperty = {
  type: "string",
  description: "Destination name or ID from list_destinations. Leave out to let Aktar choose.",
};

const TOOLS: Tool[] = [
  {
    name: "get_status",
    title: "Aktar status",
    description: "Check that Aktar is running and connected, and which version and destination it has selected.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (_args, context) => {
      const aktar = await context.client();
      const [info, all] = await Promise.all([aktar.status(), aktar.destinations()]);
      const selected = all.find((destination) => destination.id === info.defaultDestinationId);
      return json({ ...info, selectedDestination: selected?.name ?? null });
    },
  },
  {
    name: "list_destinations",
    title: "List destinations",
    description:
      "List the storage destinations set up in Aktar: name, provider, bucket, public link base, whether it's the selected one, and the file types it's used for.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (_args, context) => json({ destinations: await (await context.client()).destinations() }),
  },
  {
    name: "search_uploads",
    title: "Search uploads",
    description: "Search Aktar's upload history by file name or key, newest first. Without a query, lists the latest uploads.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Part of the file name or key." },
        destination: { ...destinationProperty, description: "Only uploads to this destination (name or ID)." },
        limit: { type: "integer", minimum: 1, maximum: 200, description: "How many to return (default 20)." },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (args, context) => {
      const aktar = await context.client();
      const limit = optionalInteger(args, "limit", 1, 200) ?? 20;
      const destination = optionalString(args, "destination");
      const uploads = await aktar.uploads({
        query: optionalString(args, "query"),
        destinationId: destination ? (await findDestination(aktar, destination)).id : undefined,
        limit,
      });
      return json({ uploads: uploads.map(summary) });
    },
  },
  {
    name: "upload_file",
    title: "Upload a file",
    description:
      "Upload a local file to the user's storage and return its link (plus Markdown and HTML). The file becomes reachable by anyone with the link. If the same file is already there, Aktar returns its existing link (reused: true).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Path of the file to upload, absolute or relative to the server's working directory." },
        destination: destinationProperty,
        name: { type: "string", description: "Upload under this name instead of the file's own (its extension is kept if this has none)." },
        folder: { type: "string", description: "Keep the file name and put it in this folder of the bucket, instead of the destination's path template." },
        expires: { type: "integer", enum: [0, 1, 7, 14, 30], description: "Delete after this many days (needs Aktar's auto-delete rules on the destination). 0 or left out keeps the file." },
      },
      required: ["path"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    run: async (args, context) => {
      const file = await readableFile(requiredString(args, "path"), context.options);
      const name = optionalString(args, "name");
      const folder = optionalString(args, "folder");
      const expires = optionalInteger(args, "expires", 0, 30);
      if (expires !== undefined && ![0, 1, 7, 14, 30].includes(expires)) throw new ToolError("expires must be 0, 1, 7, 14 or 30.");
      if (folder !== undefined && expires) throw new ToolError("folder and expires can't be combined.");
      const aktar = await context.client();
      const destination = optionalString(args, "destination");
      const uploaded = await aktar.uploadFile(file, {
        filename: name === undefined ? undefined : uploadName(name, file),
        destinationId: destination ? (await findDestination(aktar, destination)).id : undefined,
        prefix: folder,
        expires,
      });
      return json({ upload: uploaded });
    },
  },
  {
    name: "upload_clipboard",
    title: "Upload the clipboard",
    description: "Upload the file or image on the user's clipboard and return its link. The file becomes reachable by anyone with the link.",
    inputSchema: {
      type: "object",
      properties: {
        destination: destinationProperty,
        expires: { type: "integer", enum: [0, 1, 7, 14, 30], description: "Delete after this many days. 0 or left out keeps the file." },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    run: async (args, context) => {
      const expires = optionalInteger(args, "expires", 0, 30);
      if (expires !== undefined && ![0, 1, 7, 14, 30].includes(expires)) throw new ToolError("expires must be 0, 1, 7, 14 or 30.");
      const aktar = await context.client();
      const destination = optionalString(args, "destination");
      const uploaded = await aktar.uploadClipboard({
        destinationId: destination ? (await findDestination(aktar, destination)).id : undefined,
        expires,
      });
      return json({ upload: uploaded });
    },
  },
  {
    name: "replace_file",
    title: "Replace a file, keep its link",
    description:
      "Write a new local file over one already uploaded, so its key and link stay the same and everyone who has the link sees the new version. The old contents are gone. Needs Aktar for Mac 0.14.0 or Windows 0.7.0.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "What to replace: an upload ID or link from search_uploads, or a key in a destination's bucket." },
        path: { type: "string", description: "Path of the new file." },
        destination: { ...destinationProperty, description: "The destination whose bucket has the key, when target is a key. Leave out for the selected one." },
      },
      required: ["target", "path"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    run: async (args, context) => {
      const target = requiredString(args, "target");
      const file = await readableFile(requiredString(args, "path"), context.options);
      const aktar = await context.client();
      const destination = optionalString(args, "destination");
      if (UPLOAD_ID.test(target) || /^https?:\/\//i.test(target)) {
        const uploads = await aktar.uploads({ limit: 1000 });
        const match = uploads.find((upload) =>
          UPLOAD_ID.test(target) ? upload.id.toLowerCase() === target.toLowerCase() : upload.url === target,
        );
        if (!match) {
          throw new ToolError(
            UPLOAD_ID.test(target)
              ? `No upload with ID ${target} in Aktar's history.`
              : "No upload with that link in Aktar's history. Pass its key and destination instead.",
          );
        }
        return json({ upload: await aktar.replaceUpload(match.id, file) });
      }
      const destinationId = destination ? (await findDestination(aktar, destination)).id : (await aktar.status()).defaultDestinationId;
      if (!destinationId) throw new ToolError("Aktar has no destination yet.");
      return json({ upload: await aktar.replaceObject(destinationId, target.replace(/^\/+/, ""), file) });
    },
  },
  {
    name: "list_bucket",
    title: "Browse a bucket",
    description:
      "List the folders and files right under a folder of a destination's bucket, including files not uploaded with Aktar. Returns nextContinuationToken when there's more.",
    inputSchema: {
      type: "object",
      properties: {
        destination: { ...destinationProperty, description: "Destination name or ID. Leave out for the selected one." },
        prefix: { type: "string", description: "Folder to list, like \"docs/2026/\". Leave out for the top." },
        continuationToken: { type: "string", description: "nextContinuationToken from the previous page." },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (args, context) => {
      const aktar = await context.client();
      const destinationId = await destinationOrSelected(aktar, optionalString(args, "destination"));
      const listing = await aktar.listObjects(destinationId, {
        prefix: optionalString(args, "prefix"),
        continuationToken: optionalString(args, "continuationToken"),
      });
      return json(listing);
    },
  },
  {
    name: "create_temporary_link",
    title: "Create a temporary link",
    description:
      "Make a link to a file in a bucket that stops working after a while (a presigned URL), for private buckets or sharing for a limited time. Nothing in the bucket changes.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "The file's key in the bucket (objectKey in search_uploads, key in list_bucket)." },
        destination: { ...destinationProperty, description: "Destination name or ID. Leave out for the selected one." },
        minutes: { type: "integer", minimum: 1, maximum: 10080, description: "How long the link works, in minutes (default 60, at most 7 days)." },
      },
      required: ["key"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (args, context) => {
      const key = requiredString(args, "key").replace(/^\/+/, "");
      const minutes = optionalInteger(args, "minutes", 1, 10080) ?? 60;
      const aktar = await context.client();
      const destinationId = await destinationOrSelected(aktar, optionalString(args, "destination"));
      return json(await aktar.temporaryLink(destinationId, key, minutes * 60));
    },
  },
  {
    name: "get_thumbnail",
    title: "Show an upload's thumbnail",
    description:
      "Get a small preview image of an upload from search_uploads (photos, videos, PDFs, documents...), to see what a file looks like without downloading it.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The upload's ID." } },
      required: ["id"],
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
    run: async (args, context) => {
      const id = requiredString(args, "id");
      if (!UPLOAD_ID.test(id)) throw new ToolError("id must be an upload ID from search_uploads.");
      const png = await (await context.client()).uploadThumbnail(id);
      if (!png) return { content: [{ type: "text", text: "This upload has no thumbnail (thumbnails are off for its destination, or there's no preview for this kind of file)." }] };
      return { content: [{ type: "image", data: png.toString("base64"), mimeType: "image/png" }] };
    },
  },
  {
    name: "list_watched_folders",
    title: "List watched folders",
    description: "List the folders Aktar uploads new files from automatically, with their status and queue, and whether watching is paused.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
    run: async (_args, context) => json(await (await context.client()).watchedFolders()),
  },
  {
    name: "delete_upload",
    title: "Delete an upload",
    description: "Delete an upload's file from its bucket and remove it from Aktar's history. Its link stops working. This can't be undone.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The upload's ID from search_uploads." } },
      required: ["id"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    run: async (args, context) => {
      const id = requiredString(args, "id");
      if (!UPLOAD_ID.test(id)) throw new ToolError("id must be an upload ID from search_uploads.");
      return json(await (await context.client()).deleteUpload(id));
    },
  },
];

const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The tools this server offers with `options`: writing ones only unless read-only, deleting only when allowed. */
export function availableTools(options: Pick<MCPOptions, "readOnly" | "allowDelete">): Tool[] {
  return TOOLS.filter((tool) => {
    if (tool.name === "delete_upload") return options.allowDelete && !options.readOnly;
    return !options.readOnly || tool.annotations.readOnlyHint;
  });
}

/** Serves MCP until stdin closes. */
export async function serveMCP(io: IO, options: MCPOptions): Promise<void> {
  const tools = availableTools(options);
  const context: Context = {
    options,
    // Read the token on every call, so `aktar login` works without restarting the agent.
    client: async () => {
      const connection = await loadConnection(io.env);
      if (!connection) {
        throw new ToolError(
          "Not connected to Aktar yet. The user needs to run `aktar login` with the token from Aktar's Settings > Integrations (Allow local connections).",
        );
      }
      return new Client({ ...connection, port: options.port ?? connection.port });
    },
  };

  const send = (message: object) => {
    io.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  };
  const pending = new Set<Promise<void>>();

  const lines = createInterface({ input: io.stdin, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    let message: { id?: string | number | null; method?: unknown; params?: Record<string, unknown> };
    try {
      message = JSON.parse(line);
    } catch {
      send({ id: null, error: { code: ERROR.parse, message: "Parse error" } });
      continue;
    }
    if (typeof message !== "object" || message === null || Array.isArray(message) || typeof message.method !== "string") {
      // A reply to something we never ask, or not JSON-RPC at all.
      if (message && typeof message === "object" && "id" in message && !("result" in message || "error" in message)) {
        send({ id: message.id ?? null, error: { code: ERROR.invalidRequest, message: "Invalid request" } });
      }
      continue;
    }
    // Notifications (initialized, cancelled...) need no answer.
    if (message.id === undefined) continue;
    const { id, method, params } = message;
    const work = handle(method, params ?? {}, tools, context, options.version)
      .then((reply) => send({ id, ...reply }))
      .catch((error: Error) => send({ id, error: { code: -32603, message: error.message } }))
      .finally(() => pending.delete(work));
    pending.add(work);
  }
  await Promise.all(pending);
}

type Reply = { result: Record<string, unknown> } | { error: { code: number; message: string; data?: unknown } };

async function handle(method: string, params: Record<string, unknown>, tools: Tool[], context: Context, version: string): Promise<Reply> {
  const meta = (params._meta ?? {}) as Record<string, unknown>;
  const requested = typeof meta[VERSION_META] === "string" ? (meta[VERSION_META] as string) : undefined;
  if (requested !== undefined && !MODERN_VERSIONS.includes(requested) && method !== "initialize") {
    return {
      error: {
        code: ERROR.unsupportedVersion,
        message: "Unsupported protocol version",
        data: { supported: [...MODERN_VERSIONS, ...LEGACY_VERSIONS], requested },
      },
    };
  }
  // Results of the per-request era say they're complete.
  const done = (result: Record<string, unknown>): Reply => ({ result: requested ? { resultType: "complete", ...result } : result });
  const serverInfo = { name: "aktar", title: "Aktar", version };

  switch (method) {
    case "initialize": {
      const wanted = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return done({
        protocolVersion: LEGACY_VERSIONS.includes(wanted) ? wanted : LEGACY_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo,
        instructions: INSTRUCTIONS,
      });
    }
    case "server/discover":
      return done({
        supportedVersions: [...MODERN_VERSIONS, ...LEGACY_VERSIONS],
        capabilities: { tools: { listChanged: false } },
        _meta: { "io.modelcontextprotocol/serverInfo": serverInfo },
        instructions: INSTRUCTIONS,
        ...CACHE,
      });
    case "ping":
      return done({});
    case "tools/list":
      return done({
        tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({
          name,
          title,
          description,
          inputSchema,
          annotations: { title, ...annotations },
        })),
        ...CACHE,
      });
    case "tools/call": {
      const tool = tools.find((candidate) => candidate.name === params.name);
      if (!tool) return { error: { code: ERROR.invalidParams, message: `Unknown tool: ${String(params.name)}` } };
      const args = params.arguments;
      if (args !== undefined && (typeof args !== "object" || args === null || Array.isArray(args))) {
        return { error: { code: ERROR.invalidParams, message: "arguments must be an object" } };
      }
      return done(await call(tool, (args ?? {}) as Args, context));
    }
    default:
      return { error: { code: ERROR.methodNotFound, message: `Method not found: ${method}` } };
  }
}

/** Runs a tool; anything that goes wrong is a failed call the agent can read, not a protocol error. */
async function call(tool: Tool, args: Args, context: Context): Promise<ToolResult> {
  try {
    return await tool.run(args, context);
  } catch (error) {
    let message = (error as Error).message;
    if (error instanceof AktarError && error.kind === "unauthorized") {
      message += " The token doesn't match Aktar's anymore; the user needs to run `aktar login` again.";
    }
    if (error instanceof AktarError && error.status === 404 && /^Not found/i.test(message)) {
      message = "This Aktar version doesn't support that yet. Update Aktar and try again.";
    }
    return { content: [{ type: "text", text: message }], isError: true };
  }
}

function json(value: object): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
}

/** What search results show: enough to pick one and use its link, without every format of every upload. */
function summary(upload: Upload) {
  const { id, filename, url, objectKey, destinationName, mimeType, size, createdAt, expiresAt } = upload;
  return { id, filename, url, objectKey, destinationName, mimeType, size, createdAt, expiresAt: expiresAt ?? null };
}

async function findDestination(aktar: Client, wanted: string): Promise<Destination> {
  const all = await aktar.destinations();
  const match =
    all.find((destination) => destination.id.toLowerCase() === wanted.toLowerCase()) ??
    all.find((destination) => destination.name.toLowerCase() === wanted.toLowerCase());
  if (!match) {
    const names = all.map((destination) => `"${destination.name}"`).join(", ");
    throw new ToolError(`No destination named "${wanted}". Aktar has: ${names || "none yet"}.`);
  }
  return match;
}

async function destinationOrSelected(aktar: Client, wanted: string | undefined): Promise<string> {
  if (wanted) return (await findDestination(aktar, wanted)).id;
  const selected = (await aktar.status()).defaultDestinationId;
  if (!selected) throw new ToolError("Aktar has no destination yet.");
  return selected;
}

/**
 * The real path of a regular file the server may upload: inside one of
 * `--root` when any are given, so an agent can't be talked into
 * publishing files from elsewhere (SSH keys, .env files...).
 */
export async function readableFile(wanted: string, options: Pick<MCPOptions, "roots">): Promise<string> {
  const resolved = path.resolve(wanted.startsWith("~/") ? path.join(os.homedir(), wanted.slice(2)) : wanted);
  let real: string;
  try {
    real = await realpath(resolved);
  } catch {
    throw new ToolError(`No such file: ${wanted}`);
  }
  if (!(await stat(real)).isFile()) throw new ToolError(`Not a file: ${wanted}. Aktar's local API uploads one file at a time.`);
  if (options.roots.length > 0) {
    const roots = await Promise.all(options.roots.map((root) => realpath(path.resolve(root)).catch(() => path.resolve(root))));
    const inside = roots.some((root) => real === root || real.startsWith(root.endsWith(path.sep) ? root : root + path.sep));
    if (!inside) throw new ToolError(`${wanted} is outside the folders this server may upload from (${options.roots.join(", ")}).`);
  }
  return real;
}

/** Same rule as `aktar upload --name`: no slashes, and the file's extension unless the name has one. */
function uploadName(wanted: string, file: string): string {
  const name = wanted.replace(/[/\\]/g, "").trim();
  if (!name) throw new ToolError("name can't be empty.");
  return path.extname(name) ? name : `${name}${path.extname(file)}`;
}

function requiredString(args: Args, key: string): string {
  const value = optionalString(args, key);
  if (value === undefined) throw new ToolError(`${key} is required.`);
  return value;
}

function optionalString(args: Args, key: string): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ToolError(`${key} must be a string.`);
  return value.trim() === "" ? undefined : value;
}

function optionalInteger(args: Args, key: string, min: number, max: number): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  const number = typeof value === "string" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isInteger(number) || number < min || number > max) {
    throw new ToolError(`${key} must be a whole number from ${min} to ${max}.`);
  }
  return number;
}

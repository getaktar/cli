import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, type FileHandle } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

// The Aktar app's local API (Settings > Integrations). Aktar keeps the
// storage keys; this client only sends files to it on 127.0.0.1.

export const DEFAULT_PORT = 47913;
const REQUEST_TIMEOUT_MS = 30_000;
/** Bigger replies than any route sends; past this, something else is answering. */
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const HELLO_PREFIX = "aktar-hello-v1:";

/** The app proves it has the token before the client sends it (Aktar for Mac 0.18.0 / Windows 0.11.0). */
export const OUTDATED_APP_MESSAGE =
  "This version of Aktar can't prove it's Aktar before the token is sent, so the token wasn't sent. Update to Aktar for Mac 0.18.0 or Aktar for Windows 0.11.0 or later.";

export function unverifiedMessage(port: number) {
  return `The app on port ${port} couldn't prove it's Aktar, so the token wasn't sent. If Aktar is running, its token may have changed: run aktar login again.`;
}

export type Connection = { port: number; token: string };

export type OutputFormat = "url" | "markdown" | "html" | "custom";

export type Status = {
  app: string;
  version: string;
  build: string;
  apiVersion: number;
  defaultDestinationId: string | null;
  outputFormat: OutputFormat;
};

export type Destination = {
  id: string;
  name: string;
  provider: string;
  providerName: string;
  bucket: string;
  publicBaseURL: string;
  isDefault: boolean;
  /** The file types and extensions an upload without a destination goes here for (Mac 0.14.0 / Windows 0.7.0). */
  useFor?: { kinds: string[]; extensions: string[] } | null;
};

export type Upload = {
  id: string;
  filename: string;
  objectKey: string;
  url: string;
  destinationId: string;
  destinationName: string;
  mimeType: string;
  size: number;
  createdAt: string;
  expiresAt?: string | null;
  formats: Record<OutputFormat, string>;
  /** Nothing was uploaded: the same file was already there, so Aktar reused its link. */
  reused?: boolean;
  /** The upload's active short link. `formats` already use it. Older apps and Windows leave it out; the client makes that null. */
  shortUrl?: string | null;
  /** Only right after an upload: Aktar tried to make a short link and couldn't, so the links are the original ones. */
  shortLinkError?: string;
};

export type ShortLink = {
  id: string;
  shortUrl: string;
  targetUrl: string;
  provider: string;
  providerName: string;
  status: "active" | "expired" | "deleted" | "orphaned" | "unknown";
  createdAt: string;
  expiresAt: string | null;
  /** Null when the provider has no stats. */
  clicks: number | null;
  lastClickAt: string | null;
};

/** What happened to an object's short link when it was moved. */
export type ShortLinkStatus = "none" | "updated" | "orphaned" | "notUpdated";

/** Mac puts `reused` in the upload, Windows next to it. `shortLinkError` may come either way too. */
type UploadReply = { upload: Upload; reused?: boolean; shortLinkError?: string };

function withReused({ upload, reused, shortLinkError }: UploadReply): Upload {
  const value = upload.reused ?? reused;
  const error = upload.shortLinkError ?? shortLinkError;
  return withShortUrl({
    ...upload,
    ...(value === undefined ? {} : { reused: value }),
    ...(error === undefined ? {} : { shortLinkError: error }),
  });
}

/** Every upload has `shortUrl`, null when there's no short link (or the app doesn't know them). */
function withShortUrl(upload: Upload): Upload {
  return { ...upload, shortUrl: upload.shortUrl ?? null };
}

export type BucketListing = {
  prefix: string;
  folders: { prefix: string; name: string }[];
  objects: { key: string; name: string; size: number; lastModified?: string | null; url?: string | null }[];
  nextContinuationToken?: string | null;
};

export type TemporaryLink = { url: string; expiresAt: string };

export type WatchedFolders = {
  paused: boolean;
  pausedUntil?: string | null;
  folders: {
    id: string;
    name: string;
    path: string;
    enabled: boolean;
    status: string;
    destinationID?: string | null;
    waiting: number;
    uploading: number;
    failed: number;
    awaitingConfirmation: number;
  }[];
};

export type ErrorKind =
  /** Nothing is listening: Aktar isn't running, or its local API is off. */
  | "not-running"
  /** Aktar rejected the token. */
  | "unauthorized"
  /** Whatever answers on the port couldn't prove it's Aktar (or has another token), so the token wasn't sent. */
  | "unverified"
  /** Aktar answered with an error of its own (storage, validation...). */
  | "request-failed";

export class AktarError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "AktarError";
  }
}

/**
 * A file to send: its path, or a file the caller already opened and
 * checked, whose bytes are then read from that descriptor (never reopened
 * by name). The caller closes the handle.
 */
export type FileSource = string | { path: string; handle: FileHandle };

const sourcePath = (source: FileSource) => (typeof source === "string" ? source : source.path);

type RequestOptions = {
  query?: Record<string, string | number | undefined>;
  file?: { source: FileSource; onProgress?: (fraction: number) => void };
  json?: unknown;
  /** Sends no token: for /v1/hello. */
  anonymous?: boolean;
};

/** `short=1` forces a short link, `short=0` skips it, nothing lets the destination decide. */
function shortQuery(short: boolean | undefined) {
  return short === undefined ? undefined : short ? 1 : 0;
}

export class Client {
  constructor(readonly connection: Connection) {}

  /** Settled once the app on the port proved it has the token; every request waits for it. */
  private verified?: Promise<void>;

  /**
   * Asks the app to prove it has the token (an HMAC of a random nonce)
   * before the token is sent, so another program squatting the port while
   * Aktar isn't running never gets the token or any file.
   */
  verify(): Promise<void> {
    if (!this.verified) {
      const check = this.hello();
      this.verified = check;
      // A failed check is tried again next time (Aktar may have started meanwhile).
      check.catch(() => {
        if (this.verified === check) this.verified = undefined;
      });
    }
    return this.verified;
  }

  private async hello() {
    const nonce = randomBytes(32).toString("base64url");
    let reply: { app?: unknown; proof?: unknown };
    try {
      reply = await this.request("GET", "hello", { query: { nonce }, anonymous: true });
    } catch (error) {
      if (error instanceof AktarError && error.kind !== "not-running" && error.status !== undefined) {
        throw new AktarError("unverified", OUTDATED_APP_MESSAGE, error.status);
      }
      throw error;
    }
    const expected = createHmac("sha256", this.connection.token).update(`${HELLO_PREFIX}${nonce}`, "utf8").digest();
    const proof = typeof reply.proof === "string" && /^[0-9a-f]{64}$/.test(reply.proof) ? Buffer.from(reply.proof, "hex") : undefined;
    if (reply.app !== "Aktar" || !proof || !timingSafeEqual(proof, expected)) {
      throw new AktarError("unverified", unverifiedMessage(this.connection.port));
    }
  }

  status() {
    return this.request<Status>("GET", "status");
  }

  async destinations() {
    return (await this.request<{ destinations: Destination[] }>("GET", "destinations")).destinations;
  }

  async uploads(query: { query?: string; destinationId?: string; limit?: number } = {}) {
    return (await this.request<{ uploads: Upload[] }>("GET", "uploads", { query })).uploads.map(withShortUrl);
  }

  /**
   * Without a `prefix`, Aktar names the file with the destination's path
   * template, like a drop on the menu bar. With one, the file keeps its
   * name inside that folder. `filename` (the file's own by default) is the
   * name Aktar goes by: {filename} and {ext} in the template, and history.
   * `expires` is in days; leaving it out keeps the file, whatever Aktar's
   * menu bar is set to. `short` makes a short link (true) or doesn't
   * (false); left out, the destination's setting decides.
   */
  async uploadFile(
    file: FileSource,
    options: {
      filename?: string;
      destinationId?: string;
      prefix?: string;
      expires?: number;
      short?: boolean;
      onProgress?: (fraction: number) => void;
    } = {},
  ) {
    const { onProgress, filename, short, ...query } = options;
    const response = await this.request<UploadReply>("POST", "uploads", {
      query: { filename: filename ?? path.basename(sourcePath(file)), ...query, short: shortQuery(short) },
      file: { source: file, onProgress },
    });
    return withReused(response);
  }

  /**
   * Writes `filePath` over an upload in history, keeping its key and link
   * (Aktar for Mac 0.14.0 / Windows 0.7.0 or later).
   */
  async replaceUpload(id: string, file: FileSource, onProgress?: (fraction: number) => void) {
    const response = await this.request<UploadReply>("POST", `uploads/${encodeURIComponent(id)}/replace`, {
      file: { source: file, onProgress },
    });
    return withReused(response);
  }

  /** Writes `file` over the object at `key`, which keeps its link. */
  async replaceObject(destinationId: string, key: string, file: FileSource, onProgress?: (fraction: number) => void) {
    const response = await this.request<UploadReply>("PUT", `destinations/${encodeURIComponent(destinationId)}/objects`, {
      query: { key },
      file: { source: file, onProgress },
    });
    return withReused(response);
  }

  /** Deletes an upload's file from its bucket and the entry from history. */
  deleteUpload(id: string) {
    return this.request<{ deleted: string }>("DELETE", `uploads/${encodeURIComponent(id)}`);
  }

  /** An upload's thumbnail as PNG, or null when there's none (thumbnails off, or not a kind that has one). */
  async uploadThumbnail(id: string, px = 512) {
    const { body } = await this.send("GET", `uploads/${encodeURIComponent(id)}/thumbnail`, { query: { px } });
    return body.length > 0 ? body : null;
  }

  /** One page of a bucket: the folders and files right under `prefix`. */
  listObjects(destinationId: string, options: { prefix?: string; continuationToken?: string } = {}) {
    return this.request<BucketListing>("GET", `destinations/${encodeURIComponent(destinationId)}/objects`, { query: options });
  }

  /** A presigned link to `key`, valid for `expiresIn` seconds (one minute to seven days). */
  temporaryLink(destinationId: string, key: string, expiresIn: number) {
    return this.request<TemporaryLink>("POST", `destinations/${encodeURIComponent(destinationId)}/links`, {
      json: { key, expiresIn },
    });
  }

  watchedFolders() {
    return this.request<WatchedFolders>("GET", "watched-folders");
  }

  async uploadClipboard(options: { destinationId?: string; expires?: number; short?: boolean } = {}) {
    const { short, ...query } = options;
    return withReused(await this.request<UploadReply>("POST", "uploads/clipboard", { query: { ...query, short: shortQuery(short) } }));
  }

  /**
   * Makes a short link for an upload with its destination's link
   * shortener, or returns the one it already has.
   */
  async createShortLink(id: string) {
    const response = await this.request<{ shortLink: ShortLink; upload: Upload }>("POST", `uploads/${encodeURIComponent(id)}/short-link`);
    return { shortLink: response.shortLink, upload: withShortUrl(response.upload) };
  }

  /** An upload's short link, with clicks when the provider counts them, or null when it has none. */
  async shortLink(id: string) {
    return (await this.request<{ shortLink: ShortLink | null }>("GET", `uploads/${encodeURIComponent(id)}/short-link`)).shortLink ?? null;
  }

  private async request<T>(method: string, route: string, options: RequestOptions = {}): Promise<T> {
    const { body } = await this.send(method, route, options);
    try {
      const text = body.toString("utf8");
      return (text ? JSON.parse(text) : {}) as T;
    } catch {
      return {} as T;
    }
  }

  /** The raw reply of a successful request; anything else becomes an AktarError. */
  private async send(method: string, route: string, options: RequestOptions = {}): Promise<{ body: Buffer }> {
    if (!options.anonymous) await this.verify();
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) search.set(key, String(value));
    }
    const query = search.toString();

    const headers: Record<string, string | number> = { Accept: "application/json" };
    if (!options.anonymous) headers.Authorization = `Bearer ${this.connection.token}`;
    let fileSize = 0;
    const jsonBody = options.json === undefined ? undefined : Buffer.from(JSON.stringify(options.json), "utf8");
    if (jsonBody) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = jsonBody.length;
    } else if (options.file) {
      const { source } = options.file;
      fileSize = (typeof source === "string" ? await stat(source) : await source.handle.stat()).size;
      headers["Content-Type"] = "application/octet-stream";
      headers["Content-Length"] = fileSize;
    } else if (method !== "GET") {
      headers["Content-Length"] = 0;
    }

    return new Promise<{ body: Buffer }>((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port: this.connection.port,
          method,
          path: `/v1/${route}${query ? `?${query}` : ""}`,
          headers,
          // An upload takes as long as the storage provider needs. The file
          // is streamed, never read into memory, whatever its size.
          timeout: options.file ? 0 : REQUEST_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let received = 0;
          res.on("data", (chunk: Buffer) => {
            received += chunk.length;
            if (received > MAX_RESPONSE_BYTES) {
              res.destroy();
              reject(new AktarError("request-failed", "Aktar's reply was too big."));
              return;
            }
            chunks.push(chunk);
          });
          res.on("end", () => {
            const body = Buffer.concat(chunks);
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) {
              resolve({ body });
              return;
            }
            let payload: unknown = {};
            try {
              payload = JSON.parse(body.toString("utf8"));
            } catch {
              // Not JSON; fall back to the status code below.
            }
            const message = (payload as { error?: string }).error ?? `Aktar responded with HTTP ${status}.`;
            reject(new AktarError(status === 401 ? "unauthorized" : "request-failed", message, status));
          });
        },
      );

      req.on("timeout", () => req.destroy(new Error("Aktar took too long to respond.")));
      req.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "ECONNREFUSED") {
          reject(new AktarError("not-running", "Aktar isn't running, or its local API is turned off (Settings > Integrations)."));
        } else if (error.code === "EPIPE" || error.code === "ECONNRESET") {
          // Aktar closes the connection early when it rejects a request, or quits mid-upload.
          reject(new AktarError("request-failed", "Aktar closed the connection before the request finished."));
        } else {
          reject(new AktarError("request-failed", error.message));
        }
      });

      if (jsonBody) {
        req.end(jsonBody);
      } else if (options.file) {
        const { onProgress } = options.file;
        const { source } = options.file;
        // A checked file is read from the descriptor that was checked, from its start.
        const stream =
          typeof source === "string" ? createReadStream(source) : source.handle.createReadStream({ start: 0, autoClose: false });
        let sent = 0;
        stream.on("data", (chunk) => {
          sent += chunk.length;
          onProgress?.(fileSize > 0 ? sent / fileSize : 1);
        });
        stream.on("error", (error) => req.destroy(error));
        stream.pipe(req);
      } else {
        req.end();
      }
    });
  }
}

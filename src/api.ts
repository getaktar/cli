import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";

// The Aktar app's local API (Settings > Integrations). Aktar keeps the
// storage keys; this client only sends files to it on 127.0.0.1.

export const DEFAULT_PORT = 47913;
const REQUEST_TIMEOUT_MS = 30_000;

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
};

/** Mac puts `reused` in the upload, Windows next to it. */
type UploadReply = { upload: Upload; reused?: boolean };

function withReused({ upload, reused }: UploadReply): Upload {
  const value = upload.reused ?? reused;
  return value === undefined ? upload : { ...upload, reused: value };
}

export type ErrorKind =
  /** Nothing is listening: Aktar isn't running, or its local API is off. */
  | "not-running"
  /** Aktar rejected the token. */
  | "unauthorized"
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

type RequestOptions = {
  query?: Record<string, string | number | undefined>;
  file?: { path: string; onProgress?: (fraction: number) => void };
};

export class Client {
  constructor(readonly connection: Connection) {}

  status() {
    return this.request<Status>("GET", "status");
  }

  async destinations() {
    return (await this.request<{ destinations: Destination[] }>("GET", "destinations")).destinations;
  }

  async uploads(query: { query?: string; destinationId?: string; limit?: number } = {}) {
    return (await this.request<{ uploads: Upload[] }>("GET", "uploads", { query })).uploads;
  }

  /**
   * Without a `prefix`, Aktar names the file with the destination's path
   * template, like a drop on the menu bar. With one, the file keeps its
   * name inside that folder. `filename` (the file's own by default) is the
   * name Aktar goes by: {filename} and {ext} in the template, and history.
   * `expires` is in days; leaving it out keeps the file, whatever Aktar's
   * menu bar is set to.
   */
  async uploadFile(
    filePath: string,
    options: {
      filename?: string;
      destinationId?: string;
      prefix?: string;
      expires?: number;
      onProgress?: (fraction: number) => void;
    } = {},
  ) {
    const { onProgress, filename, ...query } = options;
    const response = await this.request<UploadReply>("POST", "uploads", {
      query: { filename: filename ?? path.basename(filePath), ...query },
      file: { path: filePath, onProgress },
    });
    return withReused(response);
  }

  async uploadClipboard(options: { destinationId?: string; expires?: number } = {}) {
    return withReused(await this.request<UploadReply>("POST", "uploads/clipboard", { query: options }));
  }

  private async request<T>(method: string, route: string, options: RequestOptions = {}): Promise<T> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) search.set(key, String(value));
    }
    const query = search.toString();

    const headers: Record<string, string | number> = {
      Authorization: `Bearer ${this.connection.token}`,
      Accept: "application/json",
    };
    let fileSize = 0;
    if (options.file) {
      fileSize = (await stat(options.file.path)).size;
      headers["Content-Type"] = "application/octet-stream";
      headers["Content-Length"] = fileSize;
    } else if (method !== "GET") {
      headers["Content-Length"] = 0;
    }

    return new Promise<T>((resolve, reject) => {
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
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            let payload: unknown = {};
            try {
              const text = Buffer.concat(chunks).toString("utf8");
              payload = text ? JSON.parse(text) : {};
            } catch {
              // Not JSON; fall back to the status code below.
            }
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300) {
              resolve(payload as T);
              return;
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

      if (options.file) {
        const { onProgress } = options.file;
        const stream = createReadStream(options.file.path);
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

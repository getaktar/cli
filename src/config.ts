import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_PORT, type Connection } from "./api.js";

/**
 * Where `aktar login` keeps the token: ~/.config/aktar/cli.json (or
 * $XDG_CONFIG_HOME), and %APPDATA%\aktar\cli.json on Windows. Readable by
 * the user only. AKTAR_TOKEN and AKTAR_PORT override it, for scripts and CI.
 */
export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    return path.join(env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "aktar", "cli.json");
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "aktar", "cli.json");
}

export function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const port = Number(raw);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : Number.NaN;
}

/** The saved connection with the environment applied on top, or null without a token. */
export async function loadConnection(env: NodeJS.ProcessEnv = process.env): Promise<Connection | null> {
  let saved: Partial<Connection> = {};
  try {
    saved = JSON.parse(await readFile(configPath(env), "utf8")) as Partial<Connection>;
  } catch {
    // Not logged in yet.
  }
  const token = env.AKTAR_TOKEN?.trim() || saved.token;
  if (!token) return null;
  const envPort = parsePort(env.AKTAR_PORT);
  const port = envPort !== undefined && !Number.isNaN(envPort) ? envPort : (saved.port ?? DEFAULT_PORT);
  return { token, port };
}

export async function saveConnection(connection: Connection, env: NodeJS.ProcessEnv = process.env) {
  const file = configPath(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(connection, null, 2)}\n`, { mode: 0o600 });
  // writeFile's mode only applies to new files.
  await chmod(file, 0o600).catch(() => {});
  return file;
}

export async function removeConnection(env: NodeJS.ProcessEnv = process.env) {
  await rm(configPath(env), { force: true });
}

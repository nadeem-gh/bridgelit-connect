// Where things live and which server to talk to. Nothing secret is stored here:
// the device token goes to the OS keychain (see credentials.js).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const VERSION = "0.8.0";
export const DEFAULT_SERVER = "https://bridgelit.net";

export function configDir() {
  if (process.env.BRIDGELIT_CONNECT_HOME) return process.env.BRIDGELIT_CONNECT_HOME;
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "bridgelit-connect");
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "bridgelit-connect");
}

const configFile = () => path.join(configDir(), "config.json");

/** @returns {{server?: string, device_id?: number, device_name?: string, store?: string, models?: Record<string,string>}} */
export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configFile(), "utf8"));
  } catch {
    return {};
  }
}

export function writeConfig(data) {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(configFile(), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
}

export function clearConfig() {
  fs.rmSync(configFile(), { force: true });
}

/**
 * The server base URL, without a trailing slash. HTTPS only, except for a
 * server on this computer (local development).
 * @param {string | undefined} raw
 */
export function normalizeServer(raw) {
  const text = (raw ?? "").trim() || DEFAULT_SERVER;
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`Not a valid server address: ${text}`);
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) {
    throw new Error("The server must use https:// (http:// is allowed only for localhost).");
  }
  return `${url.protocol}//${url.host}`;
}

/** The pages where the user types the login code. */
export function connectPages(server) {
  if (process.env.BRIDGELIT_READER_URL || process.env.BRIDGELIT_AUTHOR_URL) {
    return {
      reader: `${process.env.BRIDGELIT_READER_URL ?? ""}/connect`,
      author: `${process.env.BRIDGELIT_AUTHOR_URL ?? ""}/connect`,
    };
  }
  const { hostname } = new URL(server);
  if (["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
    return { reader: "http://localhost:3100/connect", author: "http://localhost:3200/connect" };
  }
  const base = hostname.replace(/^www\./, "");
  return { reader: `https://read.${base}/connect`, author: `https://author.${base}/connect` };
}

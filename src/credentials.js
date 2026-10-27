// The device token, kept in the OS credential store when there is one:
// macOS Keychain (`security`), Linux Secret Service (`secret-tool`), otherwise
// a file only this user can read (mode 0600).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { configDir } from "./config.js";

const SERVICE = "bridgelit-connect";

function run(cmd, args, input) {
  try {
    const result = spawnSync(cmd, args, { input, encoding: "utf8", timeout: 15_000 });
    return { ok: result.status === 0, out: (result.stdout ?? "").trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

function has(cmd) {
  return run(process.platform === "win32" ? "where" : "which", [cmd]).ok;
}

const fileStore = {
  name: "file",
  path: () => path.join(configDir(), "credentials.json"),
  read(server) {
    try {
      return JSON.parse(fs.readFileSync(this.path(), "utf8"))[server] ?? null;
    } catch {
      return null;
    }
  },
  write(server, token) {
    let all = {};
    try {
      all = JSON.parse(fs.readFileSync(this.path(), "utf8"));
    } catch {
      all = {};
    }
    all[server] = token;
    fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.path(), JSON.stringify(all), { mode: 0o600 });
    fs.chmodSync(this.path(), 0o600);
    return true;
  },
  remove(server) {
    try {
      const all = JSON.parse(fs.readFileSync(this.path(), "utf8"));
      delete all[server];
      fs.writeFileSync(this.path(), JSON.stringify(all), { mode: 0o600 });
    } catch {
      // nothing stored
    }
  },
};

const keychainStore = {
  name: "macOS Keychain",
  available: () => process.platform === "darwin" && has("security"),
  read: (server) => {
    const r = run("security", ["find-generic-password", "-s", SERVICE, "-a", server, "-w"]);
    return r.ok && r.out ? r.out : null;
  },
  write: (server, token) =>
    run("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", server, "-l", "BridgeLit Connect", "-w", token]).ok,
  remove: (server) => void run("security", ["delete-generic-password", "-s", SERVICE, "-a", server]),
};

const secretToolStore = {
  name: "Secret Service",
  available: () => process.platform === "linux" && has("secret-tool") && Boolean(process.env.DBUS_SESSION_BUS_ADDRESS),
  read: (server) => {
    const r = run("secret-tool", ["lookup", "service", SERVICE, "server", server]);
    return r.ok && r.out ? r.out : null;
  },
  // The token goes on stdin, never on the command line.
  write: (server, token) =>
    run("secret-tool", ["store", "--label=BridgeLit Connect", "service", SERVICE, "server", server], token).ok,
  remove: (server) => void run("secret-tool", ["clear", "service", SERVICE, "server", server]),
};

const STORES = { "macOS Keychain": keychainStore, "Secret Service": secretToolStore, file: fileStore };

/** Save the token; returns the name of the store used. */
export function saveToken(server, token) {
  // BRIDGELIT_CREDENTIAL_STORE=file skips the OS store (headless machines, tests).
  const osStores = process.env.BRIDGELIT_CREDENTIAL_STORE === "file" ? [] : [keychainStore, secretToolStore];
  for (const store of osStores) {
    if (store.available() && store.write(server, token)) return store.name;
  }
  fileStore.write(server, token);
  return fileStore.name;
}

export function loadToken(server, storeName) {
  const store = STORES[storeName] ?? fileStore;
  return store.read(server);
}

export function deleteToken(server, storeName) {
  (STORES[storeName] ?? fileStore).remove(server);
  fileStore.remove(server);
}

// Start the agent automatically at login: launchd on macOS, a systemd user
// unit on Linux. Windows users add a Task Scheduler entry (see README).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { configDir } from "./config.js";

const LABEL = "net.bridgelit.connect";
const BIN = fileURLToPath(new URL("../bin/bridgelit-connect.js", import.meta.url));

const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function launchdPlist({ node, bin, pathEnv, logFile }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xml(node)}</string><string>${xml(bin)}</string><string>start</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>${xml(pathEnv)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict>
</plist>
`;
}

export function systemdUnit({ node, bin, pathEnv }) {
  return `[Unit]
Description=BridgeLit Connect (answers BridgeLit questions with your own AI)
After=network-online.target

[Service]
ExecStart="${node}" "${bin}" start
Environment="PATH=${pathEnv}"
Restart=always
RestartSec=30

[Install]
WantedBy=default.target
`;
}

function paths() {
  return {
    node: process.execPath,
    bin: BIN,
    pathEnv: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    logFile: path.join(configDir(), "connect.log"),
  };
}

export function installService(log) {
  const p = paths();
  if (process.platform === "darwin") {
    const file = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
    spawnSync("launchctl", ["unload", file]);
    fs.writeFileSync(file, launchdPlist(p));
    const r = spawnSync("launchctl", ["load", "-w", file], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`launchctl failed: ${r.stderr}`);
    log(`Installed. BridgeLit Connect now starts when you log in. Log: ${p.logFile}`);
    return;
  }
  if (process.platform === "linux") {
    const file = path.join(os.homedir(), ".config", "systemd", "user", "bridgelit-connect.service");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, systemdUnit(p));
    spawnSync("systemctl", ["--user", "daemon-reload"]);
    const r = spawnSync("systemctl", ["--user", "enable", "--now", "bridgelit-connect.service"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`systemctl failed: ${r.stderr}`);
    log("Installed. Logs: journalctl --user -u bridgelit-connect -f");
    return;
  }
  throw new Error("Automatic start is set up by hand on Windows: see the README (Task Scheduler).");
}

export function uninstallService(log) {
  if (process.platform === "darwin") {
    const file = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
    spawnSync("launchctl", ["unload", "-w", file]);
    fs.rmSync(file, { force: true });
  } else if (process.platform === "linux") {
    spawnSync("systemctl", ["--user", "disable", "--now", "bridgelit-connect.service"]);
    fs.rmSync(path.join(os.homedir(), ".config", "systemd", "user", "bridgelit-connect.service"), { force: true });
  }
  log("Automatic start removed.");
}

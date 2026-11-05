// Start the agent automatically at login: launchd on macOS, a systemd user
// unit on Linux, and on Windows a hidden PowerShell loop started from the
// user's own Run key (HKCU, so no administrator is needed).
import { spawn, spawnSync } from "node:child_process";
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

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_NAME = "BridgeLit Connect";

const psQuote = (s) => `'${String(s).replace(/'/g, "''")}'`;

/** The PowerShell that keeps the agent running (restarting it 30 s after it stops). */
export function windowsLoop({ node, bin, pathEnv, logFile, pidFile }) {
  return [
    `Set-Content -LiteralPath ${psQuote(pidFile)} -Value $PID`,
    `$env:Path = ${psQuote(pathEnv)}`,
    `while ($true) { & ${psQuote(node)} ${psQuote(bin)} start *>> ${psQuote(logFile)}; Start-Sleep -Seconds 30 }`,
  ].join("; ");
}

/** How the Run key starts the loop: Run entries over 260 characters are ignored, so the loop is a file. */
export function windowsRunArgs({ loopFile }) {
  return ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", loopFile];
}

/** Stops the hidden loop (by its PID file) and any agent started with `start`. */
export function windowsStopScript({ pidFile }) {
  return [
    `$f = ${psQuote(pidFile)}`,
    "if (Test-Path -LiteralPath $f) { Stop-Process -Id ([int](Get-Content -LiteralPath $f)) -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath $f -Force }",
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like '*bridgelit-connect.js*' -and $_.CommandLine -match '\\sstart(\\s|$)' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }",
  ].join("; ");
}

function windowsStop(p) {
  spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", windowsStopScript(p)], { encoding: "utf8" });
}

function paths() {
  return {
    node: process.execPath,
    bin: BIN,
    pathEnv: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    logFile: path.join(configDir(), "connect.log"),
    pidFile: path.join(configDir(), "connect-loop.pid"),
    loopFile: path.join(configDir(), "connect-loop.ps1"),
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
  if (process.platform === "win32") {
    fs.mkdirSync(configDir(), { recursive: true });
    fs.writeFileSync(p.loopFile, `${windowsLoop(p)}\r\n`);
    const args = windowsRunArgs(p);
    const command = ["powershell.exe", ...args.map((a) => (a.includes(" ") ? `"${a}"` : a))].join(" ");
    const r = spawnSync("reg", ["add", RUN_KEY, "/v", RUN_NAME, "/t", "REG_SZ", "/d", command, "/f"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`Couldn't add the sign-in entry: ${r.stderr || r.stdout}`);
    windowsStop(p);
    // Start it now too, without waiting for the next sign-in.
    spawn("powershell.exe", args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
    log(`Installed. BridgeLit Connect now starts when you sign in to Windows. Log: ${p.logFile}`);
    return;
  }
  throw new Error(`Automatic start isn't supported on ${process.platform}. Run \`bridgelit-connect start\` instead.`);
}

export function uninstallService(log) {
  if (process.platform === "darwin") {
    const file = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
    spawnSync("launchctl", ["unload", "-w", file]);
    fs.rmSync(file, { force: true });
  } else if (process.platform === "linux") {
    spawnSync("systemctl", ["--user", "disable", "--now", "bridgelit-connect.service"]);
    fs.rmSync(path.join(os.homedir(), ".config", "systemd", "user", "bridgelit-connect.service"), { force: true });
  } else if (process.platform === "win32") {
    spawnSync("reg", ["delete", RUN_KEY, "/v", RUN_NAME, "/f"], { encoding: "utf8" });
    windowsStop(paths());
    fs.rmSync(paths().loopFile, { force: true });
  }
  log("Automatic start removed.");
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { launchdPlist, windowsLoop, windowsRunArgs, windowsStopScript } from "../src/service.js";
import { parseArgs } from "../src/cli.js";

const p = {
  node: "C:\\Program Files\\node\\node.exe",
  bin: "C:\\Users\\O'Neil\\.bridgelit\\node_modules\\bridgelit-connect\\bin\\bridgelit-connect.js",
  pathEnv: "C:\\Users\\O'Neil\\.bridgelit;C:\\Windows",
  logFile: "C:\\Users\\O'Neil\\AppData\\Roaming\\bridgelit-connect\\connect.log",
  pidFile: "C:\\Users\\O'Neil\\AppData\\Roaming\\bridgelit-connect\\connect-loop.pid",
  loopFile: "C:\\Users\\O'Neil\\AppData\\Roaming\\bridgelit-connect\\connect-loop.ps1",
};

test("windows loop quotes paths for PowerShell and restarts the agent", () => {
  const loop = windowsLoop(p);
  assert.match(loop, /'C:\\Users\\O''Neil\\\.bridgelit\\node_modules/);
  assert.match(loop, /while \(\$true\) \{ & 'C:\\Program Files\\node\\node\.exe' .* start \*>> .*Start-Sleep -Seconds 30 \}/);
  assert.match(loop, /Set-Content -LiteralPath '.*connect-loop\.pid' -Value \$PID/);
});

test("windows Run entry stays under 260 characters and runs hidden", () => {
  const args = windowsRunArgs(p);
  assert.deepEqual(args.slice(-2), ["-File", p.loopFile]);
  assert.ok(args.includes("Hidden"));
  assert.ok(["powershell.exe", ...args].join(" ").length < 260);
});

test("windows stop only matches agents started with start", () => {
  const script = windowsStopScript(p);
  assert.match(script, /connect-loop\.pid/);
  assert.match(script, /\\sstart\(\\s\|\$\)/);
});

test("launchd plist still escapes paths", () => {
  assert.match(launchdPlist({ node: "/a&b/node", bin: "/x", pathEnv: "/usr/bin", logFile: "/l" }), /\/a&amp;b\/node/);
});

test("login --token=CODE keeps a code that starts with a dash", () => {
  assert.equal(parseArgs(["login", "--token=-abc_DEF"]).token, "-abc_DEF");
  assert.equal(parseArgs(["login", "--token", "xyz"]).token, "xyz");
});

test("the service PATH adds the usual AI CLI folders that exist, first", async () => {
  const { servicePath } = await import("../src/service.js");
  const have = new Set(["/h/.bridgelit/bin", "/h/.local/bin", "/usr/bin"]);
  const out = servicePath("/usr/bin:/bin", ["/h/.bridgelit/bin", "/h/.local/bin", "/h/missing", "/usr/bin"], (f) => have.has(f));
  assert.equal(out, "/h/.bridgelit/bin:/h/.local/bin:/usr/bin:/bin");
  assert.equal(servicePath("", [], () => false), "/usr/local/bin:/usr/bin:/bin");
});

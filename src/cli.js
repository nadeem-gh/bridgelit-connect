// bridgelit-connect: login | start | status | doctor | logout | service
import os from "node:os";
import { setTimeout as wait } from "node:timers/promises";
import { Api, ApiError } from "./api.js";
import { RevokedError, runAgent } from "./agent.js";
import { VERSION, clearConfig, connectPages, normalizeServer, readConfig, writeConfig } from "./config.js";
import { deleteToken, loadToken, saveToken } from "./credentials.js";
import { LABELS, detect, readyProviders } from "./providers.js";
import { installService, uninstallService } from "./service.js";

const HELP = `bridgelit-connect ${VERSION}
Answer questions you ask on BridgeLit with your own Claude or ChatGPT
subscription, on this computer.

Usage:
  bridgelit-connect login [--server URL] [--name NAME]   connect this computer to your account
  bridgelit-connect start [--approve]                    stay connected and answer questions
  bridgelit-connect status                               show the connection
  bridgelit-connect doctor                               check Claude / Codex are ready
  bridgelit-connect logout                               disconnect this computer
  bridgelit-connect service install|uninstall            start automatically at login

Options:
  --server URL        BridgeLit server (default https://bridgelit.net, or BRIDGELIT_SERVER)
  --name NAME         how this computer is listed in BridgeLit (default: its host name)
  --approve           ask before answering each question (terminal only)
  --claude-model M    model for Claude, e.g. sonnet (default: Claude Code's default)
  --codex-model M     model for Codex (default: Codex's default)
  --use-api-keys      let the CLIs use ANTHROPIC_API_KEY / OPENAI_API_KEY if set
                      (by default they are hidden so your subscription login is used)
`;

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split("=", 2);
      const flag = ["approve", "use-api-keys", "help", "version"].includes(key);
      out[key] = flag ? true : inline ?? argv[++i];
    } else if (arg === "-h") out.help = true;
    else if (arg === "-v") out.version = true;
    else out._.push(arg);
  }
  return out;
}

const log = (message) => console.log(`[${new Date().toLocaleTimeString()}] ${message}`);

function session() {
  const config = readConfig();
  if (!config.server) return null;
  const token = loadToken(config.server, config.store);
  return token ? { config, api: new Api(config.server, token) } : null;
}

async function login(args) {
  const server = normalizeServer(args.server ?? process.env.BRIDGELIT_SERVER ?? readConfig().server);
  const found = detect();
  const providers = readyProviders(found);
  if (providers.length === 0) {
    console.log("Note: neither Claude nor Codex is ready yet. Run `bridgelit-connect doctor` after logging in.\n");
  }
  const api = new Api(server);
  const name = args.name ?? os.hostname();
  const { data: start } = await api.startPairing({
    name,
    providers,
    agent_version: VERSION,
    platform: `${process.platform}-${process.arch}`,
  });
  const pages = connectPages(server);
  console.log(`
  Your code:  ${start.user_code}

  Open "Connect your AI" in BridgeLit and type this code:
    Reader:  ${pages.reader}
    Author:  ${pages.author}

  Waiting for you to approve it (the code works for ${Math.round(start.expires_in / 60)} minutes)…`);

  const deadline = Date.now() + start.expires_in * 1000;
  while (Date.now() < deadline) {
    await wait(Math.max(2, start.interval) * 1000);
    let result;
    try {
      result = await api.pollPairing(start.device_code);
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) throw error;
      continue;
    }
    if (result.status === 410) throw new Error(result.data.detail ?? "The code expired. Run login again.");
    if (result.status === 200 && result.data.token) {
      const old = readConfig();
      if (old.server) deleteToken(old.server, old.store);
      const store = saveToken(server, result.data.token);
      writeConfig({ ...old, server, device_id: result.data.device.id, device_name: result.data.device.name, store });
      console.log(`
  Connected as "${result.data.device.name}". Token saved in: ${store}.

  Next: run \`bridgelit-connect start\` and keep it running while you use BridgeLit,
  or \`bridgelit-connect service install\` to start it automatically.`);
      return 0;
    }
  }
  throw new Error("The code expired before it was approved. Run login again.");
}

async function start(args) {
  const current = session();
  if (!current) {
    console.log("This computer isn't connected yet. Run `bridgelit-connect login` first.");
    return 1;
  }
  const options = {
    approve: Boolean(args.approve),
    keepApiKeys: Boolean(args["use-api-keys"]),
    models: {
      ...(current.config.models ?? {}),
      ...(args["claude-model"] ? { claude: args["claude-model"] } : {}),
      ...(args["codex-model"] ? { codex: args["codex-model"] } : {}),
    },
  };
  const controller = new AbortController();
  const stop = () => {
    if (controller.signal.aborted) process.exit(130);
    log("Stopping…");
    controller.abort();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  log(`BridgeLit Connect ${VERSION} → ${current.config.server} as "${current.config.device_name}"`);
  try {
    await runAgent(current.api, options, log, controller.signal);
  } catch (error) {
    if (error instanceof RevokedError) {
      deleteToken(current.config.server, current.config.store);
      log(error.message);
      return 1;
    }
    throw error;
  }
  return 0;
}

async function status() {
  const current = session();
  if (!current) {
    console.log("Not connected. Run `bridgelit-connect login`.");
    return 1;
  }
  const { config, api } = current;
  console.log(`Server:   ${config.server}\nComputer: ${config.device_name} (#${config.device_id})\nToken in: ${config.store}`);
  try {
    const { data } = await api.hello({ providers: readyProviders(), agent_version: VERSION, platform: `${process.platform}-${process.arch}` });
    console.log(`Account:  connected; AIs offered: ${data.device.providers.map((p) => LABELS[p]).join(", ") || "none"}`);
  } catch (error) {
    console.log(`Account:  ${error instanceof ApiError && error.status === 401 ? "disconnected - run login again" : `unreachable (${error.message})`}`);
    return 1;
  }
  return 0;
}

function doctor() {
  const major = Number(process.versions.node.split(".")[0]);
  console.log(`Node.js ${process.versions.node} ${major >= 20 ? "ok" : "- needs 20 or newer"}`);
  const found = detect();
  for (const [provider, f] of Object.entries(found)) {
    console.log(`${LABELS[provider]}: ${f.ready ? `ready (${f.version})` : f.installed ? `installed, not ready - ${f.note}` : "not installed"}`);
  }
  if (!found.claude.installed) console.log("  Install Claude Code: npm install -g @anthropic-ai/claude-code, then run `claude` and /login with your Claude plan.");
  if (!found.codex.installed) console.log("  Install Codex: npm install -g @openai/codex, then `codex login` with your ChatGPT plan.");
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY) {
    console.log("Note: an API key is set in your shell. BridgeLit Connect hides it from the CLIs so your subscription is used (pass --use-api-keys to change that).");
  }
  const current = session();
  console.log(current ? `Connected to ${current.config.server} as "${current.config.device_name}".` : "Not connected yet: run `bridgelit-connect login`.");
  return readyProviders(found).length > 0 ? 0 : 1;
}

async function logout() {
  const current = session();
  const config = readConfig();
  if (current) await current.api.logout().catch(() => undefined);
  if (config.server) deleteToken(config.server, config.store);
  clearConfig();
  console.log("Disconnected. The token was removed from this computer.");
  return 0;
}

export async function main(argv) {
  const args = parseArgs(argv);
  if (args.version) {
    console.log(VERSION);
    return 0;
  }
  const [command = "help", sub] = args._;
  if (args.help || command === "help") {
    console.log(HELP);
    return 0;
  }
  switch (command) {
    case "login":
      return login(args);
    case "start":
      return start(args);
    case "status":
      return status();
    case "doctor":
      return doctor();
    case "logout":
      return logout();
    case "service":
      if (sub === "install") installService(console.log);
      else if (sub === "uninstall") uninstallService(console.log);
      else throw new Error("Use `service install` or `service uninstall`.");
      return 0;
    default:
      console.log(HELP);
      return 1;
  }
}

// bridgelit-connect: login | start | status | doctor | logout | service
import { spawnSync } from "node:child_process";
import os from "node:os";
import readline from "node:readline";
import { setTimeout as wait } from "node:timers/promises";
import { Api, ApiError } from "./api.js";
import { API_LABELS, apiProviderFor, checkKey, keyedProviders, looksLikeKey, removeKey, saveKey } from "./apikeys.js";
import { RevokedError, runAgent } from "./agent.js";
import { VERSION, clearConfig, connectPages, normalizeServer, readConfig, writeConfig } from "./config.js";
import { deleteToken, loadToken, saveToken } from "./credentials.js";
import { LABELS, detect, readyProviders } from "./providers.js";
import { installService, uninstallService } from "./service.js";

const HELP = `bridgelit-connect ${VERSION}
Answer questions you ask on BridgeLit with your own Claude, ChatGPT or Gemini
subscription, on this computer. ChatGPT (Codex) and an OpenAI API key can
also make and enhance pictures for your books.

Usage:
  bridgelit-connect login [--server URL] [--name NAME]   connect this computer to your account
  bridgelit-connect login --token CODE                   connect with the code in a BridgeLit install line
  bridgelit-connect start [--approve]                    stay connected and answer questions
  bridgelit-connect status                               show the connection
  bridgelit-connect doctor                               check Claude / Codex / Gemini are ready
  bridgelit-connect logout                               disconnect this computer
  bridgelit-connect service install|uninstall            start automatically at login
  bridgelit-connect setup claude|chatgpt|gemini          install Claude Code, Codex or Gemini CLI and sign in
  bridgelit-connect key add|remove anthropic|openai|gemini  use your own API key (kept in your keychain)
  bridgelit-connect key list                             show which API keys are stored

Options:
  --server URL        BridgeLit server (default https://bridgelit.net, or BRIDGELIT_SERVER)
  --name NAME         how this computer is listed in BridgeLit (default: its host name)
  --approve           ask before answering each question (terminal only)
  --parallel N        answer up to N questions at once (default: BridgeLit's limit, 3)
  --claude-model M    model for Claude, e.g. sonnet (default: Claude Code's default)
  --codex-model M     model for Codex (default: Codex's default)
  --gemini-model M    model for Gemini CLI, e.g. gemini-3.8-flash (default: Gemini CLI's default)
  --anthropic-model M model for your Claude API key (default: claude-opus-5-5)
  --openai-model M    model for your OpenAI API key (default: gpt-5.5)
  --gemini-api-model M  model for your Gemini API key (default: gemini-3.1-pro-preview)
  --openai-image-model M  picture model for your OpenAI API key (default: gpt-image-1)
  --use-api-keys      let the CLIs use ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY if set
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

/** Keep the device token from an approved login, replacing this computer's old one. */
async function saveLogin(server, data) {
  const old = readConfig();
  if (old.server) {
    // Re-running the install replaces this computer instead of listing it twice.
    const oldToken = loadToken(old.server, old.store);
    if (oldToken) await new Api(old.server, oldToken).logout().catch(() => undefined);
    deleteToken(old.server, old.store);
  }
  const store = saveToken(server, data.token);
  writeConfig({ ...old, server, device_id: data.device.id, device_name: data.device.name, store });
  return store;
}

/** The one-line install: the portal already approved this login; one poll finishes it. */
async function loginWithToken(server, deviceCode, args) {
  const api = new Api(server);
  const info = {
    name: args.name ?? os.hostname().replace(/\.(local|lan|home)$/i, ""),
    providers: readyProviders(),
    agent_version: VERSION,
    platform: `${process.platform}-${process.arch}`,
  };
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let result;
    try {
      result = await api.pollPairing(deviceCode, info);
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) throw error;
      await wait(2000);
      continue;
    }
    if (result.status === 200 && result.data.token) {
      await saveLogin(server, result.data);
      console.log(`  Connected as "${result.data.device.name}".`);
      return 0;
    }
    if (result.status === 410) break;
    await wait(2000);
  }
  throw new Error("This install line has expired or was already used. Reload the BridgeLit page for a new one.");
}

async function login(args) {
  const server = normalizeServer(args.server ?? process.env.BRIDGELIT_SERVER ?? readConfig().server);
  const token = args.token ?? process.env.BRIDGELIT_PAIR_TOKEN;
  if (typeof token === "string" && token.trim()) return loginWithToken(server, token.trim(), args);
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
      const store = await saveLogin(server, result.data);
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
      ...(args["anthropic-model"] ? { anthropic_api: args["anthropic-model"] } : {}),
      ...(args["openai-model"] ? { openai_api: args["openai-model"] } : {}),
      ...(args["gemini-model"] ? { gemini: args["gemini-model"] } : {}),
      ...(args["gemini-api-model"] ? { gemini_api: args["gemini-api-model"] } : {}),
    },
    imageModel: args["openai-image-model"] ?? current.config.image_model,
    // Jobs at once (default: what BridgeLit allows, 3); 1 runs them one by one.
    parallel: Number(args.parallel ?? current.config.parallel) || undefined,
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
    console.log(`${LABELS[provider]}: ${f.ready ? `ready (${f.version})` : f.installed ? `installed, not ready - ${f.note}` : provider.endsWith("_api") ? f.note : "not installed"}`);
  }
  if (!found.claude.installed) console.log("  Set up Claude (no API key): bridgelit-connect setup claude");
  if (!found.codex.installed) console.log("  Set up ChatGPT (no API key): bridgelit-connect setup chatgpt");
  if (!found.gemini.installed) console.log("  Set up Gemini (no API key): bridgelit-connect setup gemini");
  if (process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
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

/** Read a secret without echoing it (or from stdin when piped). */
function readSecret(prompt) {
  if (!process.stdin.isTTY) {
    return new Promise((resolve) => {
      let data = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => (data += chunk));
      process.stdin.on("end", () => resolve(data.trim()));
    });
  }
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(prompt);
    rl._writeToOutput = () => undefined; // hide what is typed or pasted
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

async function keyCommand(sub, name) {
  if (sub === "list") {
    const keyed = keyedProviders();
    for (const provider of Object.keys(API_LABELS)) {
      console.log(`${API_LABELS[provider]}: ${keyed.includes(provider) ? "stored in your keychain" : "none"}`);
    }
    return 0;
  }
  const provider = apiProviderFor(name);
  if (!provider || !["add", "remove"].includes(sub)) {
    throw new Error("Use `key add anthropic`, `key add openai`, `key add gemini`, `key remove …` or `key list`.");
  }
  if (sub === "remove") {
    removeKey(provider);
    console.log(`${API_LABELS[provider]} removed from this computer.`);
    return 0;
  }
  const key = await readSecret(`Paste your ${API_LABELS[provider]} (it stays on this computer): `);
  if (!looksLikeKey(provider, key)) {
    const shapes = { anthropic_api: "an Anthropic (sk-ant-…)", openai_api: "an OpenAI (sk-…)", gemini_api: "a Gemini (AIza…)" };
    throw new Error(`That doesn't look like ${shapes[provider]} key.`);
  }
  process.stdout.write("Checking the key… ");
  const problem = await checkKey(provider, key);
  if (problem) {
    console.log("failed.");
    throw new Error(problem);
  }
  const store = saveKey(provider, key);
  console.log(`ok. Saved in: ${store}.`);
  console.log("Restart `bridgelit-connect start` (or the service) so BridgeLit offers it.");
  return 0;
}

const SETUP = {
  claude: { label: "Claude Code", pkg: "@anthropic-ai/claude-code", account: "Claude", login: ["claude", ["auth", "login"]] },
  chatgpt: { label: "Codex (ChatGPT)", pkg: "@openai/codex", account: "ChatGPT", login: ["codex", ["login"]] },
  // Gemini CLI has no login command: it asks on its first run. Choose
  // "Sign in with Google", then type /quit.
  gemini: { label: "Gemini CLI", pkg: "@google/gemini-cli", account: "Google", login: ["gemini", []] },
};
const SETUP_ALIASES = { codex: "chatgpt", google: "gemini" };

/** Install Claude Code, Codex or Gemini CLI and open its sign-in, so the user's plan can be used. */
function setup(name) {
  const what = SETUP[SETUP_ALIASES[name] ?? name];
  if (!what) throw new Error("Use `setup claude`, `setup chatgpt` or `setup gemini`.");
  const shell = process.platform === "win32";
  const installed = spawnSync(what.login[0], ["--version"], { shell, encoding: "utf8" }).status === 0;
  if (!installed) {
    console.log(`Installing ${what.label}: npm install -g ${what.pkg}`);
    const r = spawnSync("npm", ["install", "-g", what.pkg], { stdio: "inherit", shell });
    if (r.status !== 0) throw new Error(`Install failed. Run it yourself: npm install -g ${what.pkg}`);
  }
  console.log(`Signing in to ${what.label}. Choose your ${what.account} account, not an API key.`);
  if (what.pkg === "@google/gemini-cli") {
    console.log("Pick \"Sign in with Google\" when Gemini asks, then type /quit once it's ready.");
  }
  const r = spawnSync(what.login[0], what.login[1], { stdio: "inherit", shell });
  if (r.status !== 0) throw new Error(`Sign-in didn't finish. Run \`${what.login[0]} ${what.login[1].join(" ")}\` yourself.`);
  console.log("Done. Check with `bridgelit-connect doctor`.");
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
    case "key":
      return keyCommand(sub, args._[2]);
    case "setup":
      return setup(sub);
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

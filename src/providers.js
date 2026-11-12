// Runs one prompt through the user's own `claude` (Claude Code), `codex`
// (OpenAI Codex CLI) or `gemini` (Gemini CLI), signed in with their own plan.
//
// Each run is locked down: an empty temporary folder, no MCP servers, and for
// Claude and Gemini no tools at all (see gemini.js). If the model tries to use a tool anyway (read a file,
// run a command, browse), the run is stopped and nothing is sent back.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { API_LABELS, KEY_NAMES, jobImages, keyedProviders, runApiProvider } from "./apikeys.js";
import { ProviderError, ToolAttempt } from "./errors.js";
import { geminiArgs, geminiParser, geminiRunFiles, geminiSignedIn } from "./gemini.js";

export const PROVIDERS = ["claude", "codex", "gemini", "anthropic_api", "openai_api", "gemini_api"];
const CLI_PROVIDERS = ["claude", "codex", "gemini"];
export const LABELS = {
  claude: "Claude",
  codex: "ChatGPT (Codex)",
  gemini: "Gemini",
  anthropic_api: "Claude API key",
  openai_api: "OpenAI API key",
  gemini_api: "Gemini API key",
};
// Set to run a CLI from somewhere other than PATH.
const CLI_PATH_ENV = { claude: "BRIDGELIT_CLAUDE_PATH", codex: "BRIDGELIT_CODEX_PATH", gemini: "BRIDGELIT_GEMINI_PATH" };

// Removed from the CLI's environment so it uses the subscription login, not an
// API key that would bill a separate account.
const API_KEY_VARS = {
  claude: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"],
  codex: ["OPENAI_API_KEY", "CODEX_API_KEY", "OPENAI_BASE_URL", "AZURE_OPENAI_API_KEY"],
  gemini: ["GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_VERTEX_BASE_URL"],
};

const CODEX_TOOL_ITEMS = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search", "tool_call"]);

export { ProviderError, ToolAttempt };

function cliPath(provider) {
  return process.env[CLI_PATH_ENV[provider]] || provider;
}

function quick(cmd, args, env = process.env) {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 20_000, env, shell: process.platform === "win32" });
    return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
  } catch {
    return { ok: false, out: "" };
  }
}

/**
 * What is installed, and whether it can run locked down.
 * @returns {Record<string, {installed: boolean, version: string, ready: boolean, note: string}>}
 */
export function detect() {
  const out = {};
  const claude = quick(cliPath("claude"), ["--version"]);
  if (claude.ok) {
    const help = quick(cliPath("claude"), ["--help"]).out;
    const locked = help.includes("--tools") && help.includes("--strict-mcp-config");
    const auth = claudeAuth(quick(cliPath("claude"), ["auth", "status"], cleanEnv("claude", false)).out);
    out.claude = {
      installed: true,
      version: claude.out.split("\n")[0],
      ready: locked && auth.loggedIn,
      note: !locked
        ? "Update Claude Code (npm i -g @anthropic-ai/claude-code): this version can't turn tools off."
        : auth.loggedIn
          ? ""
          : "Run `claude auth login` and sign in with your Claude subscription.",
    };
  } else {
    out.claude = { installed: false, version: "", ready: false, note: "Not installed." };
  }
  const codex = quick(cliPath("codex"), ["--version"]);
  if (codex.ok) {
    const login = quick(cliPath("codex"), ["login", "status"]);
    out.codex = {
      installed: true,
      version: codex.out.split("\n")[0],
      ready: login.ok,
      note: login.ok ? "" : "Run `codex login` and sign in with ChatGPT.",
    };
  } else {
    out.codex = { installed: false, version: "", ready: false, note: "Not installed." };
  }
  const gemini = quick(cliPath("gemini"), ["--version"]);
  if (gemini.ok) {
    const help = quick(cliPath("gemini"), ["--help"]).out;
    // `--policy` (deny every tool) and `--skip-trust` came with the policy engine.
    const locked = help.includes("--policy") && help.includes("--skip-trust");
    const signedIn = geminiSignedIn();
    out.gemini = {
      installed: true,
      version: gemini.out.split("\n").pop(),
      ready: locked && signedIn,
      note: !locked
        ? "Update Gemini CLI (npm i -g @google/gemini-cli): this version can't turn tools off."
        : signedIn
          ? ""
          : "Run `gemini`, choose Sign in with Google, and use your Google AI plan.",
    };
  } else {
    out.gemini = { installed: false, version: "", ready: false, note: "Not installed." };
  }
  const keyed = keyedProviders();
  for (const provider of Object.keys(API_LABELS)) {
    const has = keyed.includes(provider);
    out[provider] = {
      installed: has,
      version: has ? "key in keychain" : "",
      ready: has,
      note: has ? "" : `No key. Add one with \`bridgelit-connect key add ${KEY_NAMES[provider]}\`.`,
    };
  }
  return out;
}

/** ``claude auth status`` output -> whether a login is there (unknown output counts as yes). */
export function claudeAuth(text) {
  try {
    const data = JSON.parse(text);
    return { loggedIn: Boolean(data.loggedIn), method: String(data.authMethod ?? "") };
  } catch {
    return { loggedIn: true, method: "" };
  }
}

export function readyProviders(found = detect()) {
  return PROVIDERS.filter((p) => found[p]?.ready);
}

export function cleanEnv(provider, keepApiKeys) {
  const env = { ...process.env };
  if (!keepApiKeys) for (const name of API_KEY_VARS[provider]) delete env[name];
  env.CI = "true";
  env.NO_COLOR = "1";
  return env;
}

export function claudeArgs({ system, model, images }) {
  const args = [
    "-p",
    // Pictures go in a stream-JSON user message (see claudeInput).
    ...(images?.length ? ["--input-format", "stream-json"] : []),
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--tools", "",
    "--strict-mcp-config",
    "--mcp-config", '{"mcpServers":{}}',
    "--no-session-persistence",
    "--system-prompt", system,
  ];
  if (model) args.push("--model", model);
  return args;
}

// Codex tools a text job never needs. With them on, the model sometimes searches
// the web or runs commands, and the agent has to throw the answer away. Set as
// `-c` values so a Codex that doesn't know one of them still runs.
const CODEX_TOOLS_OFF = [
  "shell_tool",
  "unified_exec",
  "apps",
  "browser_use",
  "browser_use_external",
  "in_app_browser",
  "computer_use",
  "image_generation",
  "view_image",
  "skill_search",
  "tool_suggest",
  "sleep_tool",
];

export function codexToolsOff() {
  return [
    "-c", 'web_search="disabled"',
    ...CODEX_TOOLS_OFF.flatMap((name) => ["-c", `features.${name}=false`]),
  ];
}

export function codexArgs({ model, imagePaths }) {
  const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", ...codexToolsOff()];
  if (model) args.push("--model", model);
  for (const imagePath of imagePaths ?? []) args.push("--image", imagePath);
  // `--image` takes several values, so end the options before the stdin marker.
  if (imagePaths?.length) args.push("--");
  args.push("-");
  return args;
}

/** What `claude -p` reads on stdin: the plain prompt, or one stream-JSON message with pictures. */
export function claudeInput(prompt, images) {
  if (!images?.length) return prompt;
  const content = images.map((i) => ({
    type: "image",
    source: { type: "base64", media_type: i.media_type, data: i.data },
  }));
  content.push({ type: "text", text: prompt });
  return `${JSON.stringify({ type: "user", message: { role: "user", content } })}\n`;
}

const EXTENSIONS = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** Reads Claude Code `stream-json` lines. */
export function claudeParser() {
  let text = "";
  let final = null;
  let error = null;
  return {
    /** @returns {{partial?: string}} */
    line(raw) {
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        return {};
      }
      if (event.type === "stream_event") {
        const e = event.event ?? {};
        const block = e.content_block?.type;
        if (e.type === "content_block_start" && block && !["text", "thinking", "redacted_thinking"].includes(block)) {
          throw new ToolAttempt(`The model tried to use a tool (${block}).`);
        }
        if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
          text += e.delta.text ?? "";
          return { partial: text };
        }
        return {};
      }
      if (event.type === "assistant") {
        for (const part of event.message?.content ?? []) {
          if (part.type === "tool_use" || part.type === "server_tool_use") {
            throw new ToolAttempt(`The model tried to use a tool (${part.name ?? part.type}).`);
          }
        }
        return {};
      }
      if (event.type === "result") {
        if (event.is_error || (event.subtype && event.subtype !== "success")) {
          error = String(event.result || event.subtype || "Claude failed.");
        } else {
          final = String(event.result ?? text);
        }
      }
      return {};
    },
    result() {
      return { answer: final ?? text, error };
    },
  };
}

/** Reads `codex exec --json` lines. */
export function codexParser() {
  let answer = "";
  let error = null;
  return {
    line(raw) {
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        return {};
      }
      const item = event.item ?? {};
      if ((event.type === "item.started" || event.type === "item.completed") && CODEX_TOOL_ITEMS.has(item.type)) {
        throw new ToolAttempt(`The model tried to use a tool (${item.type}).`);
      }
      if (event.type === "item.completed" && (item.type === "agent_message" || item.item_type === "assistant_message")) {
        answer = String(item.text ?? "");
        return { partial: answer };
      }
      if (event.type === "error" || event.type === "turn.failed") {
        error = String(event.message ?? event.error?.message ?? "Codex failed.");
      }
      return {};
    },
    result() {
      return { answer, error };
    },
  };
}

export function friendlyError(provider, message) {
  const text = String(message ?? "");
  if (/401|unauthori[sz]ed|invalid api key|please run \/login|not logged in|log ?in|auth method|set an auth/i.test(text)) {
    return {
      claude: "Claude isn't signed in on this computer. Run `claude`, then /login with your Claude subscription.",
      codex: "Codex isn't signed in on this computer. Run `codex login` and sign in with ChatGPT.",
      gemini: "Gemini isn't signed in on this computer. Run `gemini` and choose Sign in with Google.",
    }[provider] ?? `${LABELS[provider]} isn't signed in on this computer.`;
  }
  if (provider === "gemini" && /RESOURCE_EXHAUSTED|quota/i.test(text)) {
    return "Your Gemini plan is at its usage limit right now. Try again later.";
  }
  if (/429|rate.?limit|usage limit|too many requests|overloaded/i.test(text)) {
    return `Your ${LABELS[provider]} plan is at its usage limit right now. Try again later.`;
  }
  return text.slice(0, 280) || `${LABELS[provider]} failed.`;
}

/**
 * Run one job. Resolves with the answer text; rejects with ProviderError.
 * @param {{provider: string, system: string, prompt: string, timeoutMs: number,
 *          model?: string, keepApiKeys?: boolean, onPartial?: (text: string) => void,
 *          signal?: AbortSignal}} job
 */
export async function runProvider(job) {
  if (job.provider?.endsWith("_api")) return runApiProvider(job);
  return runCli(job);
}

function runCli(job) {
  const { provider } = job;
  if (!CLI_PROVIDERS.includes(provider)) return Promise.reject(new ProviderError(`Unknown AI: ${provider}`));
  const images = jobImages(job.images);
  if (provider === "gemini" && images.length) {
    // Gemini CLI reads pictures only through its file tools, which stay off.
    return Promise.reject(
      new ProviderError("Gemini CLI can't read page pictures with its tools off. Use your Gemini API key for this."),
    );
  }
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "bridgelit-"));
  // Codex reads pictures from files; they live in the job's own folder.
  const imagePaths = provider === "codex"
    ? images.map((image, n) => {
        const file = path.join(workdir, `page-${n + 1}.${EXTENSIONS[image.media_type]}`);
        fs.writeFileSync(file, Buffer.from(image.data, "base64"));
        return file;
      })
    : [];
  const gemini = provider === "gemini" ? geminiRunFiles(workdir, job.system) : null;
  const args = provider === "claude"
    ? claudeArgs({ ...job, images })
    : gemini
      ? geminiArgs({ ...job, policyPath: gemini.policyPath })
      : codexArgs({ ...job, imagePaths });
  // Gemini gets BridgeLit's system prompt from a file (GEMINI_SYSTEM_MD).
  const input = provider === "claude"
    ? claudeInput(job.prompt, images)
    : gemini
      ? job.prompt
      : `${job.system}\n\n---\n\n${job.prompt}`;
  const parser = provider === "claude" ? claudeParser() : gemini ? geminiParser() : codexParser();

  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = "";
    let buffer = "";
    const child = spawn(cliPath(provider), args, {
      cwd: workdir,
      env: { ...cleanEnv(provider, job.keepApiKeys), ...(gemini?.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });

    const finish = (error, answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      job.signal?.removeEventListener("abort", onAbort);
      if (child.exitCode === null) child.kill("SIGKILL");
      fs.rmSync(workdir, { recursive: true, force: true });
      if (error) reject(error);
      else resolve(answer);
    };
    const onAbort = () => finish(new ProviderError("Stopped."));
    const timer = setTimeout(
      () => finish(new ProviderError(`${LABELS[provider]} took too long and was stopped.`)),
      job.timeoutMs,
    );
    job.signal?.addEventListener("abort", onAbort);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const raw = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!raw) continue;
        try {
          const { partial } = parser.line(raw);
          if (partial !== undefined) job.onPartial?.(partial);
        } catch (error) {
          finish(error instanceof ProviderError ? error : new ProviderError(String(error)));
          return;
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on("error", (error) =>
      finish(new ProviderError(error.code === "ENOENT" ? `${LABELS[provider]} CLI is not installed.` : error.message)),
    );
    child.on("close", (code) => {
      if (buffer.trim()) {
        try {
          parser.line(buffer.trim());
        } catch (error) {
          finish(error);
          return;
        }
      }
      const { answer, error } = parser.result();
      if (error) finish(new ProviderError(friendlyError(provider, error)));
      else if (code !== 0 && !answer) finish(new ProviderError(friendlyError(provider, stderr || `exit code ${code}`)));
      else if (!answer.trim()) finish(new ProviderError(`${LABELS[provider]} returned an empty answer.`));
      else finish(null, answer.trim());
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(input);
  });
}

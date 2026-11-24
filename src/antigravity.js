// The user's own `agy` (Google Antigravity CLI), signed in with their Google
// account (Google AI Free / Pro / Ultra). Gemini CLI no longer serves those
// plans, so this is how a Google plan answers BridgeLit jobs.
//
// Each run is locked down three ways (checked against agy 1.5.16):
// - a custom agent in the run folder (`.agents/agents/bridgelit.md`) with
//   `tools: []`: the model is offered no file, shell, web, browser or MCP tool,
//   and the agent's body is BridgeLit's system prompt in place of agy's own;
// - per-run settings (`--settings`, never saved) that deny every command, file
//   read or write, URL and MCP call, and ask before any other tool (`strict`),
//   so a tool that slipped through still can't touch anything;
// - `--sandbox` (terminal sandbox, no network for commands).
// If the model still uses a tool, the run is stopped (see antigravityParser).
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolAttempt } from "./errors.js";

export const AGENT_NAME = "bridgelit";

// agy keeps one tool even with `tools: []`: `manage_task` lists and stops the
// run's own background tasks. A locked-down run has none, so it can do nothing.
export const HARMLESS_TOOLS = new Set(["manage_task"]);

/** Settings for this run only (`--settings`); deny wins over anything the user allows. */
export function antigravitySettings() {
  return {
    toolPermission: "strict",
    agentMode: "",
    allowNonWorkspaceAccess: false,
    enableTerminalSandbox: true,
    disableSlashCommands: true,
    permissions: {
      allow: [],
      deny: [
        "command(*)",
        "read_file(*)",
        "write_file(*)",
        "read_url(*)",
        "execute_url(*)",
        "download_url(*)",
        "mcp(*)",
      ],
    },
  };
}

/** The run's agent file: no tools, no MCP servers, BridgeLit's system prompt as its body. */
export function antigravityAgent(system) {
  return [
    "---",
    `name: ${AGENT_NAME}`,
    "description: Answers one BridgeLit request from the text it is given, with no tools.",
    "tools: []",
    "mcpServers: []",
    "skills: []",
    "plugins: []",
    "mainAgent: true",
    "subagent: false",
    "commandExecutionPolicy: off",
    "---",
    "",
    system || "Answer the user's request.",
    "",
    "You have no tools. Answer only from the text in the request.",
    "",
  ].join("\n");
}

/** Writes the run folder's agent file. */
export function antigravityRunFiles(workdir, system) {
  const dir = path.join(workdir, ".agents", "agents");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${AGENT_NAME}.md`), antigravityAgent(system));
}

export function antigravityArgs({ model }) {
  const args = [
    // The prompt comes on stdin as one stream-JSON message (no argv size limit).
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--agent", AGENT_NAME,
    "--settings", JSON.stringify(antigravitySettings()),
    "--sandbox",
    "--disable-slash-commands",
  ];
  if (model) args.push("--model", model);
  return args;
}

/** What agy reads on stdin: one user message. */
export function antigravityInput(prompt) {
  return `${JSON.stringify({ event: "user", message: { content: [{ type: "text", text: prompt }] } })}\n`;
}

/** Where agy is: BRIDGELIT_AGY_PATH, else PATH, else the installer's ~/.local/bin. */
export function antigravityPath(env = process.env, exists = fs.existsSync) {
  if (env.BRIDGELIT_AGY_PATH) return env.BRIDGELIT_AGY_PATH;
  const local = path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "agy.exe" : "agy");
  const onPath = spawnSync(process.platform === "win32" ? "where" : "which", ["agy"], { encoding: "utf8" });
  if (onPath.status === 0 && onPath.stdout.trim()) return "agy";
  return exists(local) ? local : "agy";
}

/**
 * Whether a Google sign-in is stored. agy has no status command; on macOS its
 * token is a Keychain item (service "gemini", account "antigravity"). Elsewhere
 * this can't be checked, so it counts as yes and a run reports a missing sign-in.
 */
export function antigravitySignedIn(platform = process.platform, run = spawnSync) {
  if (platform !== "darwin") return true;
  const r = run("security", ["find-generic-password", "-s", "gemini", "-a", "antigravity"], { encoding: "utf8" });
  return r.status === 0;
}

/** Reads `agy --output-format stream-json` lines. */
export function antigravityParser() {
  let text = "";
  let final = null;
  let error = null;
  return {
    line(raw) {
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        return {};
      }
      if (event.event === "step_update") {
        const step = event.step_update ?? {};
        if (step.step_type === "tool" && !HARMLESS_TOOLS.has(step.tool_name)) {
          throw new ToolAttempt(`The model tried to use a tool (${step.tool_name ?? "tool"}).`);
        }
        if (step.step_type === "agent_response" && step.text_delta) {
          text += String(step.text_delta);
          return { partial: text };
        }
        return {};
      }
      if (event.event === "result") {
        const result = event.result ?? {};
        if (result.status === "SUCCESS") final = String(result.response ?? "");
        else error = String(result.error || `Antigravity stopped (${result.status ?? "error"}).`);
      }
      return {};
    },
    result() {
      return { answer: final ?? text, error };
    },
  };
}

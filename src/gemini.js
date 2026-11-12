// The user's own `gemini` (Gemini CLI), signed in with their Google account
// (Gemini Code Assist / Google AI Pro or Ultra), run with every tool off.
//
// Lock-down for each run, in the job's empty temporary folder:
// - a policy file (`--policy`) that denies every tool and every MCP tool;
// - workspace settings (`.gemini/settings.json`, which outrank the user's own)
//   with no core tools, every built-in tool excluded, no context files and no
//   directory listing; `--skip-trust` lets the CLI read them in this folder.
//   (A system settings file would rank higher, but the CLI only reads one in a
//   folder owned by root.)
// - no MCP server allowed (`--allowed-mcp-server-names` names one that doesn't exist);
// - BridgeLit's system prompt in place of the CLI's agent prompt (GEMINI_SYSTEM_MD).
// If the model still asks for a tool, the run is stopped (see geminiParser).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolAttempt } from "./errors.js";

// Built-in tools as Gemini CLI 0.68 names them; excluded on top of `core: []`.
export const GEMINI_TOOLS = [
  "activate_skill",
  "ask_user",
  "complete_task",
  "enter_plan_mode",
  "exit_plan_mode",
  "get_internal_docs",
  "glob",
  "google_web_search",
  "grep_search",
  "invoke_agent",
  "list_directory",
  "list_mcp_resources",
  "read_file",
  "read_many_files",
  "read_mcp_resource",
  "replace",
  "run_shell_command",
  "save_memory",
  "take_snapshot",
  "tracker_add_dependency",
  "tracker_create_task",
  "tracker_get_task",
  "tracker_list_tasks",
  "tracker_update_task",
  "tracker_visualize",
  "update_topic",
  "web_fetch",
  "write_file",
  "write_todos",
];

const NO_MCP = "bridgelit-no-mcp";

/** The settings every run gets (written as the run folder's workspace settings). */
export function geminiSettings() {
  return {
    tools: { core: [], exclude: GEMINI_TOOLS },
    mcp: { allowed: [NO_MCP] },
    context: { fileName: "BRIDGELIT_NO_CONTEXT.md", includeDirectoryTree: false },
    skills: { enabled: false },
    general: { checkpointing: { enabled: false } },
    telemetry: { enabled: false },
  };
}

// Every tool, built-in or MCP, is refused, whatever mode the CLI is in.
export const GEMINI_DENY_POLICY = `[[rule]]
toolName = "*"
decision = "deny"
priority = 999

[[rule]]
toolName = "*"
mcpName = "*"
decision = "deny"
priority = 999
`;

export function geminiArgs({ model, policyPath }) {
  const args = [
    "--output-format", "stream-json",
    "--skip-trust",
    "--allowed-mcp-server-names", NO_MCP,
  ];
  if (policyPath) args.push("--policy", policyPath);
  if (model) args.push("--model", model);
  // No prompt argument: the prompt comes on stdin, which runs the CLI headless.
  return args;
}

/**
 * Writes the run's settings, policy and system prompt into ``workdir``.
 * @returns {{policyPath: string, env: Record<string, string>}}
 */
export function geminiRunFiles(workdir, system) {
  fs.mkdirSync(path.join(workdir, ".gemini"), { recursive: true });
  fs.writeFileSync(path.join(workdir, ".gemini", "settings.json"), JSON.stringify(geminiSettings()));
  const policyPath = path.join(workdir, "bridgelit-deny.toml");
  fs.writeFileSync(policyPath, GEMINI_DENY_POLICY);
  const systemPath = path.join(workdir, "bridgelit-system.md");
  fs.writeFileSync(systemPath, system || "Answer the user's request.");
  return { policyPath, env: { GEMINI_SYSTEM_MD: systemPath } };
}

/** Where the CLI keeps its Google sign-in. */
export function geminiHome(env = process.env) {
  return path.join(env.GEMINI_CLI_HOME || os.homedir(), ".gemini");
}

/** Whether a Google sign-in is stored (the CLI has no `auth status` command). */
export function geminiSignedIn(home = geminiHome(), exists = fs.existsSync) {
  return exists(path.join(home, "oauth_creds.json"));
}

/** Reads `gemini --output-format stream-json` lines. */
export function geminiParser() {
  let text = "";
  let error = null;
  return {
    line(raw) {
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        return {};
      }
      if (event.type === "tool_use") {
        throw new ToolAttempt(`The model tried to use a tool (${event.tool_name ?? "tool"}).`);
      }
      if (event.type === "message" && event.role === "assistant") {
        text = event.delta ? text + String(event.content ?? "") : String(event.content ?? "");
        return { partial: text };
      }
      if (event.type === "error" && event.severity !== "warning") {
        error = String(event.message ?? "Gemini failed.");
      }
      if (event.type === "result") {
        if (event.status && event.status !== "success") {
          error = String(event.error?.message ?? error ?? "Gemini failed.");
        }
      }
      return {};
    },
    result() {
      return { answer: text, error };
    },
  };
}

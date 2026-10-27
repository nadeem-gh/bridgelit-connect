import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolAttempt, claudeArgs, claudeAuth, claudeParser, codexArgs, codexParser, friendlyError } from "../src/providers.js";

const line = (o) => JSON.stringify(o);

test("claude runs with every tool and MCP server turned off", () => {
  const args = claudeArgs({ system: "SYS", model: "sonnet" });
  assert.deepEqual(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2), ["--tools", ""]);
  assert.ok(args.includes("--strict-mcp-config"));
  assert.equal(args[args.indexOf("--mcp-config") + 1], '{"mcpServers":{}}');
  assert.equal(args[args.indexOf("--system-prompt") + 1], "SYS");
  assert.equal(args[args.indexOf("--model") + 1], "sonnet");
});

test("codex runs read-only and reads the prompt from stdin", () => {
  const args = codexArgs({});
  assert.deepEqual(args, ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "-"]);
});

test("claude parser streams text and returns the final result", () => {
  const p = claudeParser();
  const delta = (text) => line({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
  assert.equal(p.line(delta("Hel")).partial, "Hel");
  assert.equal(p.line(delta("lo")).partial, "Hello");
  p.line("not json");
  p.line(line({ type: "result", subtype: "success", result: "Hello [1]" }));
  assert.deepEqual(p.result(), { answer: "Hello [1]", error: null });
});

test("claude parser stops on any tool use", () => {
  const start = line({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use", name: "Read" } } });
  assert.throws(() => claudeParser().line(start), ToolAttempt);
  const msg = line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } });
  assert.throws(() => claudeParser().line(msg), ToolAttempt);
  const thinking = line({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "thinking" } } });
  assert.doesNotThrow(() => claudeParser().line(thinking));
});

test("claude parser reports errors", () => {
  const p = claudeParser();
  p.line(line({ type: "result", subtype: "success", is_error: true, result: "Invalid API key · Please run /login" }));
  assert.match(p.result().error, /login/);
});

test("codex parser keeps the last agent message and stops on commands", () => {
  const p = codexParser();
  p.line(line({ type: "item.completed", item: { type: "agent_message", text: "Answer [2]" } }));
  p.line(line({ type: "turn.completed", usage: {} }));
  assert.deepEqual(p.result(), { answer: "Answer [2]", error: null });
  const cmd = line({ type: "item.started", item: { type: "command_execution", command: "cat ~/.ssh/id_rsa" } });
  assert.throws(() => codexParser().line(cmd), ToolAttempt);
});

test("friendly errors point at the fix", () => {
  assert.match(friendlyError("claude", "401 Unauthorized"), /\/login/);
  assert.match(friendlyError("codex", "not logged in"), /codex login/);
  assert.match(friendlyError("codex", "429 Too Many Requests"), /usage limit/);
});

test("claude login is read from `claude auth status`", () => {
  assert.equal(claudeAuth('{"loggedIn": false, "authMethod": "none"}').loggedIn, false);
  assert.equal(claudeAuth('{"loggedIn": true, "authMethod": "claude.ai"}').method, "claude.ai");
  assert.equal(claudeAuth("older CLI without the command").loggedIn, true);
});

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
  assert.deepEqual(args.slice(0, 5), ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only"]);
  assert.equal(args.at(-1), "-");
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

test("a job's page picture goes to Claude as a stream-JSON message", async () => {
  const { claudeArgs, claudeInput } = await import("../src/providers.js");
  const images = [{ media_type: "image/jpeg", data: "QUJD" }];
  const args = claudeArgs({ system: "S", images });
  assert.deepEqual(args.slice(1, 3), ["--input-format", "stream-json"]);
  assert.ok(!claudeArgs({ system: "S" }).includes("--input-format"));
  const message = JSON.parse(claudeInput("Fix the lines.", images));
  assert.equal(message.type, "user");
  assert.deepEqual(message.message.content[0], {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: "QUJD" },
  });
  assert.deepEqual(message.message.content[1], { type: "text", text: "Fix the lines." });
  assert.equal(claudeInput("plain", []), "plain");
});

test("Codex gets the page picture as an --image file before the stdin marker", async () => {
  const { codexArgs } = await import("../src/providers.js");
  const args = codexArgs({ imagePaths: ["/tmp/x/page-1.jpg"] });
  assert.deepEqual(args.slice(-4), ["--image", "/tmp/x/page-1.jpg", "--", "-"]);
  assert.deepEqual(codexArgs({}).slice(-1), ["-"]);
  assert.ok(!codexArgs({}).includes("--"));
});

test("only usable pictures from the job are sent", async () => {
  const { jobImages } = await import("../src/apikeys.js");
  assert.deepEqual(jobImages(undefined), []);
  assert.deepEqual(
    jobImages([
      { media_type: "image/png", data: "QQ==" },
      { media_type: "text/html", data: "PGI+" },
      { media_type: "image/jpeg", data: "" },
    ]),
    [{ media_type: "image/png", data: "QQ==" }],
  );
});

test("codex text jobs run with web search and tools turned off", async () => {
  const { codexArgs } = await import("../src/providers.js");
  const args = codexArgs({});
  assert.equal(args[args.indexOf('web_search="disabled"') - 1], "-c");
  for (const name of ["shell_tool", "unified_exec", "browser_use", "computer_use", "view_image"]) {
    assert.ok(args.includes(`features.${name}=false`), name);
  }
  assert.ok(!args.includes("--disable"));
});

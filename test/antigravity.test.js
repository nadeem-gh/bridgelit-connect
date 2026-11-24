import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  AGENT_NAME,
  antigravityAgent,
  antigravityArgs,
  antigravityInput,
  antigravityParser,
  antigravityPath,
  antigravityRunFiles,
  antigravitySettings,
  antigravitySignedIn,
} from "../src/antigravity.js";
import { LABELS, PROVIDERS, ProviderError, ToolAttempt, cleanEnv, friendlyError, runProvider } from "../src/providers.js";

test("antigravity is a CLI provider with a label", () => {
  assert.ok(PROVIDERS.includes("antigravity"));
  assert.equal(LABELS.antigravity, "Gemini (Antigravity)");
});

test("agy runs headless with the no-tools agent, deny-all settings and the sandbox", () => {
  const args = antigravityArgs({ model: "gemini-3.8-flash-medium" });
  const at = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(at("--input-format"), "stream-json");
  assert.equal(at("--output-format"), "stream-json");
  assert.equal(at("--agent"), AGENT_NAME);
  assert.equal(at("--model"), "gemini-3.8-flash-medium");
  assert.ok(args.includes("--sandbox"));
  assert.ok(args.includes("--disable-slash-commands"));
  assert.ok(!args.includes("--dangerously-skip-permissions"));
  assert.ok(!args.includes("-p") && !args.includes("--mode"));
  assert.deepEqual(JSON.parse(at("--settings")), antigravitySettings());
  assert.ok(!antigravityArgs({}).includes("--model"));

  const settings = antigravitySettings();
  assert.equal(settings.toolPermission, "strict");
  assert.equal(settings.agentMode, "");
  assert.deepEqual(settings.permissions.allow, []);
  for (const rule of ["command(*)", "read_file(*)", "write_file(*)", "read_url(*)", "execute_url(*)", "download_url(*)", "mcp(*)"]) {
    assert.ok(settings.permissions.deny.includes(rule), rule);
  }
});

test("the run's agent has no tools, no MCP servers and BridgeLit's system prompt", () => {
  const text = antigravityAgent("Translate into Urdu.");
  const [, front, body] = text.split(/^---$/m);
  assert.match(front, /^name: bridgelit$/m);
  assert.match(front, /^tools: \[\]$/m);
  assert.match(front, /^mcpServers: \[\]$/m);
  assert.match(front, /^subagent: false$/m);
  assert.match(front, /^commandExecutionPolicy: off$/m);
  assert.match(body, /Translate into Urdu\./);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-"));
  try {
    antigravityRunFiles(dir, "Answer in Urdu.");
    assert.equal(fs.readFileSync(path.join(dir, ".agents", "agents", "bridgelit.md"), "utf8"), antigravityAgent("Answer in Urdu."));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the prompt goes on stdin as one stream-JSON user message", () => {
  const line = antigravityInput("Question: who?\nLine two");
  assert.ok(line.endsWith("\n"));
  assert.equal(line.trim().split("\n").length, 1);
  assert.deepEqual(JSON.parse(line), {
    event: "user",
    message: { content: [{ type: "text", text: "Question: who?\nLine two" }] },
  });
});

test("agy parser streams text, keeps the final answer and stops on a tool", () => {
  const step = (s) => JSON.stringify({ event: "step_update", step_update: s });
  const p = antigravityParser();
  p.line(JSON.stringify({ event: "init", init: { tools: ["run_command"] } }));
  p.line(step({ step_type: "user_input", state: "DONE" }));
  assert.deepEqual(p.line(step({ step_type: "agent_response", state: "ACTIVE", text_delta: "Sal" })), { partial: "Sal" });
  assert.deepEqual(p.line(step({ step_type: "agent_response", state: "DONE", text_delta: "aam" })), { partial: "Salaam" });
  // The one tool agy keeps with `tools: []` can only see the run's own (absent) background tasks.
  assert.deepEqual(p.line(step({ step_type: "tool", tool_name: "manage_task", state: "DONE" })), {});
  p.line(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "Salaam\n" } }));
  assert.deepEqual(p.result(), { answer: "Salaam\n", error: null });

  for (const tool of ["run_command", "view_file", "read_url_content", "search_web", "call_mcp_tool", undefined]) {
    const q = antigravityParser();
    assert.throws(() => q.line(step({ step_type: "tool", tool_name: tool, state: "ACTIVE" })), ToolAttempt);
  }

  const r = antigravityParser();
  r.line(JSON.stringify({ event: "result", result: { status: "ERROR", error: "authentication failed or timed out" } }));
  assert.equal(r.result().error, "authentication failed or timed out");
  const c = antigravityParser();
  c.line(JSON.stringify({ event: "result", result: { status: "CANCELED" } }));
  assert.match(c.result().error, /CANCELED/);
});

test("agy sign-in is the Keychain item on macOS", () => {
  const calls = [];
  const run = (status) => (cmd, args) => {
    calls.push([cmd, ...args]);
    return { status };
  };
  assert.equal(antigravitySignedIn("darwin", run(0)), true);
  assert.deepEqual(calls[0], ["security", "find-generic-password", "-s", "gemini", "-a", "antigravity"]);
  assert.ok(!calls[0].includes("-w"), "never reads the token itself");
  assert.equal(antigravitySignedIn("darwin", run(44)), false);
  assert.equal(antigravitySignedIn("linux", run(44)), true);
});

test("agy path: env override, else PATH, else ~/.local/bin", () => {
  assert.equal(antigravityPath({ BRIDGELIT_AGY_PATH: "/opt/agy" }), "/opt/agy");
});

test("Google keys in the shell are hidden from agy", () => {
  const saved = { ...process.env };
  process.env.GEMINI_API_KEY = "x";
  process.env.AGY_ADC_AUTH = "true";
  try {
    const env = cleanEnv("antigravity", false);
    assert.equal(env.GEMINI_API_KEY, undefined);
    assert.equal(env.AGY_ADC_AUTH, undefined);
  } finally {
    process.env = saved;
  }
});

test("agy and Gemini CLI errors point at the fix", () => {
  assert.match(friendlyError("antigravity", "authentication failed or timed out"), /Run `agy`/);
  assert.match(friendlyError("antigravity", "RESOURCE_EXHAUSTED"), /usage limit/);
  assert.match(
    friendlyError("gemini", "This client is no longer supported for Gemini Code Assist for individuals."),
    /setup antigravity/,
  );
});

test("runProvider runs agy locked down and reads its stream", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-fake-"));
  const record = path.join(dir, "seen.json");
  const fake = path.join(dir, "agy");
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs = require("fs");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({
    args: process.argv.slice(2), input, cwd: process.cwd(),
    agent: fs.readFileSync(".agents/agents/bridgelit.md", "utf8"),
    key: process.env.GEMINI_API_KEY ?? null,
  }));
  const say = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
  say({ event: "init", init: { tools: ["manage_task"], agent: "bridgelit" } });
  say({ event: "step_update", step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: "Jawab " } });
  say({ event: "step_update", step_update: { step_type: "agent_response", state: "DONE", text_delta: "hazir." } });
  say({ event: "result", result: { status: "SUCCESS", response: "Jawab hazir.\\n" } });
});
`,
    { mode: 0o755 },
  );
  const saved = { ...process.env };
  process.env.BRIDGELIT_AGY_PATH = fake;
  process.env.GEMINI_API_KEY = "should-be-hidden";
  const partials = [];
  try {
    const answer = await runProvider({
      provider: "antigravity",
      system: "Answer from the passages.",
      prompt: "Question: who?",
      model: "gemini-3.8-flash-medium",
      timeoutMs: 20_000,
      onPartial: (t) => partials.push(t),
    });
    assert.equal(answer, "Jawab hazir.");
    assert.deepEqual(partials, ["Jawab ", "Jawab hazir."]);
    const seen = JSON.parse(fs.readFileSync(record, "utf8"));
    assert.equal(JSON.parse(seen.input).message.content[0].text, "Question: who?");
    assert.equal(seen.agent, antigravityAgent("Answer from the passages."));
    assert.equal(seen.key, null);
    assert.ok(seen.args.includes("--sandbox"));
    assert.ok(!fs.existsSync(seen.cwd), "the run folder is removed");
  } finally {
    process.env = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("runProvider stops agy when it uses a tool", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-tool-"));
  const fake = path.join(dir, "agy");
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
process.stdin.resume().on("end", () => {
  process.stdout.write(JSON.stringify({ event: "step_update", step_update: { step_type: "tool", tool_name: "run_command", state: "ACTIVE" } }) + "\\n");
  setTimeout(() => process.stdout.write(JSON.stringify({ event: "result", result: { status: "SUCCESS", response: "leak" } }) + "\\n"), 50);
});
`,
    { mode: 0o755 },
  );
  const saved = { ...process.env };
  process.env.BRIDGELIT_AGY_PATH = fake;
  try {
    await assert.rejects(
      runProvider({ provider: "antigravity", system: "s", prompt: "p", timeoutMs: 20_000 }),
      (e) => e instanceof ToolAttempt,
    );
  } finally {
    process.env = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("agy refuses page pictures instead of dropping them", async () => {
  await assert.rejects(
    runProvider({
      provider: "antigravity",
      system: "s",
      prompt: "p",
      timeoutMs: 1000,
      images: [{ media_type: "image/png", data: "iVBORw0KGgo=" }],
    }),
    (e) => e instanceof ProviderError && /Gemini API key/.test(e.message),
  );
});

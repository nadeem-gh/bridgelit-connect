import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { apiProviderFor, geminiChunk, geminiRetryDelay, looksLikeKey, runApiProvider } from "../src/apikeys.js";
import { ProviderError, RateLimited } from "../src/errors.js";
import {
  GEMINI_DENY_POLICY,
  GEMINI_TOOLS,
  geminiArgs,
  geminiParser,
  geminiRunFiles,
  geminiSettings,
  geminiSignedIn,
} from "../src/gemini.js";
import { LABELS, PROVIDERS, ToolAttempt, cleanEnv, friendlyError, runProvider } from "../src/providers.js";

const KEY = "AIzaSyTESTKEYTESTKEYTESTKEYTESTKEY12345";

test("gemini and gemini_api are providers with labels", () => {
  assert.ok(PROVIDERS.includes("gemini"));
  assert.ok(PROVIDERS.includes("gemini_api"));
  assert.equal(LABELS.gemini, "Gemini");
  assert.equal(LABELS.gemini_api, "Gemini API key");
  assert.equal(apiProviderFor("gemini"), "gemini_api");
  assert.equal(apiProviderFor("Google"), "gemini_api");
  assert.ok(looksLikeKey("gemini_api", KEY));
  assert.ok(!looksLikeKey("gemini_api", "AIza-short"));
});

test("Gemini CLI runs headless with no tools, no MCP and a deny-all policy", () => {
  const args = geminiArgs({ model: "gemini-3.8-flash", policyPath: "/tmp/x/deny.toml" });
  assert.deepEqual(args, [
    "--output-format", "stream-json",
    "--skip-trust",
    "--allowed-mcp-server-names", "bridgelit-no-mcp",
    "--policy", "/tmp/x/deny.toml",
    "--model", "gemini-3.8-flash",
  ]);
  // No prompt argument and no -p: the prompt comes on stdin.
  assert.ok(!args.includes("-p") && !args.includes("--yolo"));
  const settings = geminiSettings();
  assert.deepEqual(settings.tools.core, []);
  for (const tool of ["run_shell_command", "read_file", "web_fetch", "google_web_search", "write_file"]) {
    assert.ok(settings.tools.exclude.includes(tool), tool);
  }
  assert.deepEqual(settings.mcp.allowed, ["bridgelit-no-mcp"]);
  assert.equal(settings.context.includeDirectoryTree, false);
  assert.match(GEMINI_DENY_POLICY, /toolName = "\*"\ndecision = "deny"/);
  assert.match(GEMINI_DENY_POLICY, /mcpName = "\*"/);
  assert.equal(new Set(GEMINI_TOOLS).size, GEMINI_TOOLS.length);
});

test("a Gemini run folder gets its settings, policy and system prompt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-test-"));
  try {
    const files = geminiRunFiles(dir, "Answer in Urdu.");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, ".gemini", "settings.json"), "utf8")), geminiSettings());
    assert.equal(fs.readFileSync(files.policyPath, "utf8"), GEMINI_DENY_POLICY);
    assert.equal(fs.readFileSync(files.env.GEMINI_SYSTEM_MD, "utf8"), "Answer in Urdu.");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Gemini parser streams deltas and stops on any tool use", () => {
  const p = geminiParser();
  p.line(JSON.stringify({ type: "init", model: "gemini-3.8-flash" }));
  p.line(JSON.stringify({ type: "message", role: "user", content: "hi" }));
  assert.deepEqual(p.line(JSON.stringify({ type: "message", role: "assistant", content: "Sal", delta: true })), { partial: "Sal" });
  assert.deepEqual(p.line(JSON.stringify({ type: "message", role: "assistant", content: "aam", delta: true })), { partial: "Salaam" });
  p.line(JSON.stringify({ type: "result", status: "success" }));
  assert.deepEqual(p.result(), { answer: "Salaam", error: null });

  const q = geminiParser();
  assert.throws(() => q.line(JSON.stringify({ type: "tool_use", tool_name: "run_shell_command" })), ToolAttempt);

  const r = geminiParser();
  r.line(JSON.stringify({ type: "result", status: "error", error: { message: "quota exceeded" } }));
  assert.equal(r.result().error, "quota exceeded");
});

test("Gemini sign-in is the stored Google login", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-home-"));
  try {
    assert.equal(geminiSignedIn(dir), false);
    fs.writeFileSync(path.join(dir, "oauth_creds.json"), "{}");
    assert.equal(geminiSignedIn(dir), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Gemini API keys in the shell are hidden from the CLI", () => {
  const saved = { ...process.env };
  process.env.GEMINI_API_KEY = "x";
  process.env.GOOGLE_API_KEY = "y";
  try {
    const env = cleanEnv("gemini", false);
    assert.equal(env.GEMINI_API_KEY, undefined);
    assert.equal(env.GOOGLE_API_KEY, undefined);
    assert.equal(cleanEnv("gemini", true).GEMINI_API_KEY, "x");
  } finally {
    process.env = saved;
  }
});

test("Gemini sign-in and quota errors point at the fix", () => {
  assert.match(friendlyError("gemini", "Please set an Auth method in your settings.json"), /Sign in with Google/);
  assert.match(friendlyError("gemini", "RESOURCE_EXHAUSTED"), /usage limit/);
});

test("runProvider runs the gemini CLI locked down and reads its stream", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gemini-fake-"));
  const record = path.join(dir, "seen.json");
  const fake = path.join(dir, "gemini");
  fs.writeFileSync(
    fake,
    `#!/usr/bin/env node
const fs = require("fs");
let input = "";
process.stdin.on("data", (d) => (input += d)).on("end", () => {
  const policy = process.argv[process.argv.indexOf("--policy") + 1];
  fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({
    args: process.argv.slice(2), input, cwd: process.cwd(),
    system: fs.readFileSync(process.env.GEMINI_SYSTEM_MD, "utf8"),
    settings: JSON.parse(fs.readFileSync(".gemini/settings.json", "utf8")),
    policy: fs.readFileSync(policy, "utf8"),
    key: process.env.GEMINI_API_KEY ?? null,
  }));
  const say = (e) => process.stdout.write(JSON.stringify(e) + "\\n");
  say({ type: "init", model: "gemini-3.8-flash" });
  say({ type: "message", role: "assistant", content: "Jawab ", delta: true });
  say({ type: "message", role: "assistant", content: "hazir.", delta: true });
  say({ type: "result", status: "success" });
});
`,
    { mode: 0o755 },
  );
  const saved = { ...process.env };
  process.env.BRIDGELIT_GEMINI_PATH = fake;
  process.env.GEMINI_API_KEY = "should-be-hidden";
  const partials = [];
  try {
    const answer = await runProvider({
      provider: "gemini",
      system: "Answer from the passages.",
      prompt: "Question: who?",
      model: "gemini-3.8-flash",
      timeoutMs: 20_000,
      onPartial: (t) => partials.push(t),
    });
    assert.equal(answer, "Jawab hazir.");
    assert.deepEqual(partials, ["Jawab ", "Jawab hazir."]);
    const seen = JSON.parse(fs.readFileSync(record, "utf8"));
    assert.equal(seen.input, "Question: who?");
    assert.equal(seen.system, "Answer from the passages.");
    assert.deepEqual(seen.settings.tools.core, []);
    assert.equal(seen.policy, GEMINI_DENY_POLICY);
    assert.equal(seen.key, null);
    assert.ok(seen.args.includes("--skip-trust"));
    assert.ok(!fs.existsSync(seen.cwd), "the run folder is removed");
  } finally {
    process.env = saved;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Gemini CLI refuses page pictures instead of dropping them", async () => {
  await assert.rejects(
    runProvider({
      provider: "gemini",
      system: "s",
      prompt: "p",
      timeoutMs: 1000,
      images: [{ media_type: "image/png", data: "iVBORw0KGgo=" }],
    }),
    (e) => e instanceof ProviderError && /Gemini API key/.test(e.message),
  );
});

// --- Gemini API key ---

let server;
let seen = [];

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      const key = req.headers["x-goog-api-key"];
      const fail = (status, error) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error }));
      };
      if (key === "bad") return fail(400, { code: 400, status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key." });
      if (key === "slow") {
        return fail(429, {
          code: 429,
          status: "RESOURCE_EXHAUSTED",
          message: "Resource has been exhausted (e.g. check quota).",
          details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "7s" }],
        });
      }
      if (key === "daily") {
        return fail(429, { code: 429, status: "RESOURCE_EXHAUSTED", message: "Quota exceeded for metric: generate_content_free_tier_requests, limit: 0, per day" });
      }
      if (key === "blocked") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`data: ${JSON.stringify({ promptFeedback: { blockReason: "SAFETY" } })}\n\n`);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const chunk = (parts, finishReason) => `data: ${JSON.stringify({ candidates: [{ content: { role: "model", parts }, ...(finishReason ? { finishReason } : {}) }] })}\r\n\r\n`;
      res.write(chunk([{ text: "thinking…", thought: true }, { text: "Salaam " }]));
      res.end(chunk([{ text: "dunya." }], "STOP"));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.BRIDGELIT_GEMINI_BASE_URL = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

const job = (extra = {}) => ({ provider: "gemini_api", system: "Be brief.", prompt: "Say hi", timeoutMs: 10_000, ...extra });

test("Gemini API key: streams text (thoughts left out), no tools, key in a header", async () => {
  seen = [];
  const partials = [];
  const answer = await runApiProvider(
    job({ model: "gemini-3.1-pro-preview", onPartial: (t) => partials.push(t), images: [{ media_type: "image/png", data: "iVBORw0KGgo=" }] }),
    () => KEY,
  );
  assert.equal(answer, "Salaam dunya.");
  assert.deepEqual(partials, ["Salaam ", "Salaam dunya."]);
  const [req] = seen;
  assert.equal(req.url, "/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse");
  assert.equal(req.headers["x-goog-api-key"], KEY);
  assert.ok(!req.url.includes(KEY), "the key never goes in the URL");
  assert.equal(req.body.tools, undefined);
  assert.deepEqual(req.body.systemInstruction, { parts: [{ text: "Be brief." }] });
  assert.deepEqual(req.body.contents[0].parts, [
    { inlineData: { mimeType: "image/png", data: "iVBORw0KGgo=" } },
    { text: "Say hi" },
  ]);
});

test("Gemini API key: default model when none is picked", async () => {
  seen = [];
  await runApiProvider(job(), () => KEY);
  assert.match(seen[0].url, /models\/gemini-3\.1-pro-preview:/);
});

test("Gemini API key: bad key, rate limit, daily quota and a block", async () => {
  await assert.rejects(runApiProvider(job(), () => "bad"), (e) => e instanceof ProviderError && /rejected/.test(e.message));
  await assert.rejects(
    runApiProvider(job(), () => "slow"),
    (e) => e instanceof RateLimited && e.retryAfter === 7,
  );
  await assert.rejects(
    runApiProvider(job(), () => "daily"),
    (e) => e instanceof ProviderError && !(e instanceof RateLimited) && /out of quota/.test(e.message),
  );
  await assert.rejects(runApiProvider(job(), () => "blocked"), (e) => e instanceof ProviderError && /declined/.test(e.message));
  await assert.rejects(runApiProvider(job(), () => null), (e) => e instanceof ProviderError && /No Gemini API key/.test(e.message));
});

test("Gemini helpers: retry delay and chunk text", () => {
  assert.equal(geminiRetryDelay([{ retryDelay: "1.5s" }]), 2);
  assert.equal(geminiRetryDelay([]), null);
  assert.deepEqual(geminiChunk({ candidates: [{ content: { parts: [{ text: "a" }, { text: "b", thought: true }] }, finishReason: "STOP" }] }), { text: "a", finish: "STOP" });
});

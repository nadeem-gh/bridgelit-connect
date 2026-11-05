import assert from "node:assert/strict";
import http from "node:http";
import { after, before, test } from "node:test";
import { apiProviderFor, looksLikeKey, retryAfterSeconds, runApiProvider } from "../src/apikeys.js";
import { ProviderError, RateLimited } from "../src/errors.js";

let server;
let seen = [];
const sse = (res, events) => {
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const [event, data] of events) res.write(`${event ? `event: ${event}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
  res.end();
};

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      const sent = req.headers["x-api-key"] ?? req.headers.authorization?.replace(/^Bearer /, "");
      if (sent === "sk-ant-bad" || sent === "sk-bad") {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }));
        return;
      }
      if (sent === "sk-ant-slowdown") {
        res.writeHead(429, { "Content-Type": "application/json", "retry-after": "0" });
        res.end(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }));
        return;
      }
      if (sent === "sk-nocredit-0000000000000000000") {
        res.writeHead(429, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "quota", type: "insufficient_quota", code: "insufficient_quota" } }));
        return;
      }
      if (req.url.startsWith("/v1/messages")) {
        const msg = { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } };
        sse(res, [
          ["message_start", { type: "message_start", message: msg }],
          ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "East " } }],
          ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "[1]." } }],
          ["content_block_stop", { type: "content_block_stop", index: 0 }],
          ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }],
          ["message_stop", { type: "message_stop" }],
        ]);
      } else if (req.url.startsWith("/v1/chat/completions")) {
        const chunk = (content) => ({ id: "c1", object: "chat.completion.chunk", created: 1, model: "gpt-5.5", choices: [{ index: 0, delta: { content }, finish_reason: null }] });
        sse(res, [[null, chunk("North ")], [null, chunk("[2].")], [null, "[DONE]"]]);
      } else {
        res.writeHead(404).end();
      }
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  process.env.BRIDGELIT_ANTHROPIC_BASE_URL = base;
  process.env.BRIDGELIT_OPENAI_BASE_URL = `${base}/v1`;
});

after(() => server.close());

const job = (provider) => ({ provider, system: "SYS", prompt: "PROMPT", timeoutMs: 5000 });

test("names and key shapes", () => {
  assert.equal(apiProviderFor("ChatGPT"), "openai_api");
  assert.equal(apiProviderFor("claude"), "anthropic_api");
  assert.equal(apiProviderFor("x"), null);
  assert.ok(looksLikeKey("anthropic_api", `sk-ant-${"a".repeat(30)}`));
  assert.ok(!looksLikeKey("anthropic_api", "sk-short"));
});

test("Claude API key: streams text, no tools, opts into fallbacks", async () => {
  seen = [];
  const partials = [];
  const answer = await runApiProvider({ ...job("anthropic_api"), onPartial: (t) => partials.push(t) }, () => "sk-ant-good");
  assert.equal(answer, "East [1].");
  assert.deepEqual(partials, ["East ", "East [1]."]);
  const { body, headers } = seen[0];
  assert.equal(headers["x-api-key"] ?? headers.authorization?.replace(/^Bearer /, ""), "sk-ant-good");
  assert.equal(body.model, "claude-opus-5-5");
  assert.equal(body.system, "SYS");
  assert.equal(body.fallbacks, "default");
  assert.match(headers["anthropic-beta"], /server-side-fallback-2026-07-01/);
  assert.equal(body.tools, undefined);
});

test("OpenAI API key: streams chat completion text", async () => {
  seen = [];
  const answer = await runApiProvider({ ...job("openai_api"), model: "gpt-x" }, () => "sk-good-key");
  assert.equal(answer, "North [2].");
  assert.equal(seen[0].body.model, "gpt-x");
  assert.equal(seen[0].body.messages[0].role, "system");
  assert.equal(seen[0].body.tools, undefined);
});

test("bad key and missing key give clear errors", async () => {
  await assert.rejects(runApiProvider(job("anthropic_api"), () => "sk-ant-bad"), (e) => e instanceof ProviderError && /rejected/.test(e.message));
  await assert.rejects(runApiProvider(job("openai_api"), () => "sk-bad"), /rejected/);
  await assert.rejects(runApiProvider(job("openai_api"), () => null), /No OpenAI API key/);
});

test("a rate limit is RateLimited with the wait; no credit is a plain error", async () => {
  await assert.rejects(
    runApiProvider(job("anthropic_api"), () => "sk-ant-slowdown"),
    (e) => e instanceof RateLimited && e.retryAfter === 0 && /rate limit/.test(e.message),
  );
  await assert.rejects(
    runApiProvider(job("openai_api"), () => "sk-nocredit-0000000000000000000"),
    (e) => e instanceof ProviderError && !(e instanceof RateLimited) && /out of credit/.test(e.message),
  );
});

test("retry-after: seconds, milliseconds, a date, or 30 by default", () => {
  assert.equal(retryAfterSeconds({ headers: { "retry-after": "12" } }), 12);
  assert.equal(retryAfterSeconds({ headers: new Headers({ "retry-after-ms": "1500" }) }), 2);
  const now = Date.parse("2026-11-05T10:00:00Z");
  assert.equal(retryAfterSeconds({ headers: { "retry-after": "Thu, 05 Nov 2026 10:00:45 GMT" } }, now), 45);
  assert.equal(retryAfterSeconds({}), 30);
});

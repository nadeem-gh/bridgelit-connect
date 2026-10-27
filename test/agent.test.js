import assert from "node:assert/strict";
import { test } from "node:test";
import { handleJob } from "../src/agent.js";
import { ProviderError, ToolAttempt } from "../src/providers.js";

function fakeApi() {
  const calls = [];
  return {
    calls,
    progress: async (id, partial) => {
      calls.push(["progress", id, partial]);
      return { data: { keep_going: true } };
    },
    result: async (id, body) => {
      calls.push(["result", id, body]);
      return { data: { ok: true } };
    },
  };
}

const job = { id: 7, provider: "claude", system: "S", prompt: "P\n\nQuestion: why?", max_answer_chars: 20, timeout_seconds: 5 };
const quiet = () => undefined;

test("sends the answer back, capped", async () => {
  const api = fakeApi();
  await handleJob(api, job, {}, quiet, async ({ onPartial }) => {
    onPartial("partial");
    return "An answer that is longer than twenty characters";
  });
  const result = api.calls.find((c) => c[0] === "result");
  assert.equal(result[2].answer.length, 20);
});

test("a tool attempt is reported, never answered", async () => {
  const api = fakeApi();
  await handleJob(api, job, {}, quiet, async () => {
    throw new ToolAttempt("The model tried to use a tool (Bash).");
  });
  assert.match(api.calls.at(-1)[2].error, /discarded/);
});

test("private data in the answer is withheld", async () => {
  const api = fakeApi();
  await handleJob(api, job, {}, quiet, async () => "-----BEGIN RSA PRIVATE KEY-----");
  assert.match(api.calls.at(-1)[2].error, /withheld/);
  assert.equal(api.calls.at(-1)[2].answer, undefined);
});

test("CLI failures are passed on", async () => {
  const api = fakeApi();
  await handleJob(api, job, {}, quiet, async () => {
    throw new ProviderError("Claude isn't signed in on this computer.");
  });
  assert.equal(api.calls.at(-1)[2].error, "Claude isn't signed in on this computer.");
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { handleJob } from "../src/agent.js";
import { ProviderError, ToolAttempt } from "../src/providers.js";
import { RateLimited } from "../src/errors.js";

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

import { parallelLimit, runAgent } from "../src/agent.js";

test("parallel limit: server limit, lowered by --parallel, one with --approve", () => {
  assert.equal(parallelLimit(undefined), 1);
  assert.equal(parallelLimit(3), 3);
  assert.equal(parallelLimit(3, { parallel: 2 }), 2);
  assert.equal(parallelLimit(3, { parallel: 9 }), 3);
  assert.equal(parallelLimit(3, { approve: true }), 1);
});

test("uses the server's suggested model when none is set", async () => {
  const api = fakeApi();
  let used;
  await handleJob(api, { ...job, provider: "codex", model: "gpt-5.6-luna" }, {}, quiet, async ({ model }) => {
    used = model;
    return "ok";
  });
  assert.equal(used, "gpt-5.6-luna");
});

test("a model set in Connect wins over the suggestion", async () => {
  const api = fakeApi();
  let used;
  await handleJob(
    api,
    { ...job, provider: "codex", model: "gpt-5.6-luna" },
    { models: { codex: "gpt-6.1-terra" } },
    quiet,
    async ({ model }) => {
      used = model;
      return "ok";
    },
  );
  assert.equal(used, "gpt-6.1-terra");
});

test("a suggested model the plan refuses falls back to the CLI default", async () => {
  const api = fakeApi();
  const models = [];
  await handleJob(api, { ...job, provider: "codex", model: "gpt-x" }, {}, quiet, async ({ model }) => {
    models.push(model);
    if (model) throw new ProviderError("model_not_found: The model gpt-x does not exist");
    return "ok";
  });
  assert.deepEqual(models, ["gpt-x", undefined]);
  assert.deepEqual(api.calls.at(-1), ["result", 7, { answer: "ok" }]);
});

test("a model the user picked in BridgeLit wins over Connect's own setting", async () => {
  const api = fakeApi();
  let used;
  await handleJob(
    api,
    { ...job, provider: "codex", model: "gpt-5.6-luna", model_chosen: true },
    { models: { codex: "gpt-6.1-terra" } },
    quiet,
    async ({ model }) => {
      used = model;
      return "ok";
    },
  );
  assert.equal(used, "gpt-5.6-luna");
});

test("a picked model the plan refuses fails the job instead of using another", async () => {
  const api = fakeApi();
  const models = [];
  await handleJob(api, { ...job, provider: "codex", model: "gpt-x", model_chosen: true }, {}, quiet, async ({ model }) => {
    models.push(model);
    throw new ProviderError("model_not_found: The model gpt-x does not exist");
  });
  assert.deepEqual(models, ["gpt-x"]);
  const [kind, id, body] = api.calls.at(-1);
  assert.equal(kind, "result");
  assert.equal(id, 7);
  assert.match(body.error, /gpt-x/);
});

test("runs jobs in parallel up to the server's limit", async () => {
  const queue = [1, 2, 3, 4].map((id) => ({ ...job, id }));
  let running = 0;
  let peak = 0;
  const controller = new AbortController();
  const api = {
    hello: async () => ({ data: {} }),
    progress: async () => ({ data: { keep_going: true } }),
    result: async () => {
      if (queue.length === 0 && running === 0) controller.abort();
      return { data: { ok: true } };
    },
    nextJob: async () => ({ data: { job: queue.shift() ?? null, max_parallel: 3, next_poll_ms: 1000 } }),
  };
  const options = {
    run: async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 30));
      running -= 1;
      return "ok";
    },
  };
  await runAgent(api, options, quiet, controller.signal);
  assert.equal(peak, 3);
});

test("the first hello says the agent just started", async () => {
  const hellos = [];
  const controller = new AbortController();
  const api = {
    hello: async (body) => {
      hellos.push(body);
      return { data: {} };
    },
    nextJob: async () => {
      controller.abort();
      return { data: { job: null } };
    },
  };
  await runAgent(api, {}, quiet, controller.signal);
  assert.equal(hellos[0].started, true);
});

test("a short rate limit is waited out on the computer", async () => {
  const api = fakeApi();
  let tries = 0;
  await handleJob(api, job, {}, quiet, async () => {
    tries += 1;
    if (tries < 3) throw new RateLimited("Your Claude API key hit its rate limit.", 0);
    return "ok";
  });
  assert.equal(tries, 3);
  assert.deepEqual(api.calls.find((c) => c[0] === "result")[2], { answer: "ok" });
});

test("a long rate limit goes back to BridgeLit with retry_after, not as a failure", async () => {
  const api = fakeApi();
  let tries = 0;
  await handleJob(api, job, {}, quiet, async () => {
    tries += 1;
    throw new RateLimited("Your OpenAI API key hit its rate limit.", 120);
  });
  assert.equal(tries, 1);
  const body = api.calls.find((c) => c[0] === "result")[2];
  assert.equal(body.retry_after, 120);
  assert.match(body.error, /rate limit/);
});

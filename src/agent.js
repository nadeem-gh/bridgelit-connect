// The loop that keeps this computer connected: ask the server for work every
// couple of seconds, run each job through the local AI, send the answer back.
import os from "node:os";
import readline from "node:readline/promises";
import { ApiError } from "./api.js";
import { RateLimited } from "./errors.js";
import { VERSION } from "./config.js";
import { privateDataReason } from "./guard.js";
import { IMAGE_PROVIDERS, runImage } from "./images.js";
import { LABELS, ProviderError, ToolAttempt, cleanEnv, detect, readyProviders, runProvider } from "./providers.js";

const HELLO_EVERY_MS = 60_000;
const DETECT_EVERY_MS = 5 * 60_000;
const PARTIAL_EVERY_MS = 700;
const MAX_BACKOFF_MS = 60_000;
// While every local slot is busy, say hello this often so the computer stays online.
const BUSY_HELLO_MS = 20_000;
// A CLI's refusal of a model the server suggested (the user's plan doesn't offer it).
// A rate-limited API key: wait here this many times (each wait at most
// LOCAL_WAIT_MAX_S), then hand the job back to BridgeLit to send again later.
const RATE_RETRIES = 2;
const LOCAL_WAIT_MAX_S = 60;
const MODEL_REFUSED = /model[^\n]{0,80}(not found|not supported|unknown|invalid|does not exist|not available|isn't available)|model_not_found/i;

/** Jobs to run at once: the server's limit, lowered by ``--parallel``; one with --approve. */
export function parallelLimit(serverMax, options = {}) {
  if (options.approve) return 1;
  const server = Math.max(1, Number(serverMax) || 1);
  const local = Number(options.parallel);
  return local > 0 ? Math.min(server, Math.floor(local)) : server;
}

export const sleep = (ms, signal) =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });

export function backoff(attempt) {
  const base = Math.min(MAX_BACKOFF_MS, 2000 * 2 ** Math.min(attempt, 5));
  return base / 2 + Math.random() * (base / 2);
}

export class RevokedError extends Error {}

function lastQuestion(prompt) {
  const line = prompt.trim().split("\n").pop() ?? "";
  return line.replace(/^(Question|Search):\s*/, "");
}

async function confirm(job) {
  if (!process.stdin.isTTY) return false;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(
      `\nAnswer with ${LABELS[job.provider]}? "${lastQuestion(job.prompt).slice(0, 160)}" [y/N] `,
    );
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** The ready AIs that can also make pictures. */
export function imageProviders(providers) {
  return providers.filter((p) => IMAGE_PROVIDERS.includes(p));
}

/** Make one picture and send it back; never throws for job failures. */
export async function handleImageJob(api, job, options, log, run = runImage) {
  const started = Date.now();
  const what = job.input_image_b64 ? "Enhancing a picture" : "Making a picture";
  log(`${what} with ${LABELS[job.provider] ?? job.provider}: "${job.prompt.slice(0, 80)}"`);
  if (options.approve && !(await confirm({ ...job, prompt: `Picture: ${job.prompt}` }))) {
    await api.result(job.id, { error: "Declined on the computer." }).catch(() => undefined);
    log("Declined.");
    return;
  }
  let body;
  try {
    const image = await run(
      {
        provider: job.provider,
        prompt: job.prompt,
        input_image_b64: job.input_image_b64,
        timeoutMs: Math.max(30, Number(job.timeout_seconds) || 360) * 1000,
        model: options.models?.[job.provider],
        imageModel: options.imageModel,
      },
      job.provider === "codex" ? { codex: { env: cleanEnv("codex", options.keepApiKeys) } } : {},
    );
    body = { image_b64: image };
  } catch (error) {
    body = { error: error instanceof ProviderError ? error.message : "Something went wrong on the computer." };
  }
  try {
    await api.result(job.id, body);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 409)) throw error;
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  log(body.image_b64 ? `Picture sent in ${seconds}s.` : `No picture: ${body.error}`);
}

/**
 * Run one job end to end; never throws for job failures (they are reported).
 * @param {import("./api.js").Api} api
 */
export async function handleJob(api, job, options, log, run = options?.run ?? runProvider) {
  const started = Date.now();
  log(`Answering with ${LABELS[job.provider] ?? job.provider}: "${lastQuestion(job.prompt).slice(0, 80)}"`);
  if (options.approve && !(await confirm(job))) {
    await api.result(job.id, { error: "Declined on the computer." }).catch(() => undefined);
    log("Declined.");
    return;
  }
  const stop = new AbortController();
  let lastSent = 0;
  let pending = null;
  let sending = false;
  const sendPartial = async (text) => {
    if (sending) return;
    sending = true;
    try {
      const { data } = await api.progress(job.id, text);
      if (data?.keep_going === false) stop.abort();
    } catch {
      // a missed progress update is fine; the final answer is what counts
    } finally {
      sending = false;
    }
  };
  const onPartial = (text) => {
    if (privateDataReason(text)) {
      stop.abort();
      return;
    }
    pending = text;
    if (Date.now() - lastSent >= PARTIAL_EVERY_MS) {
      lastSent = Date.now();
      void sendPartial(pending.slice(0, job.max_answer_chars));
    }
  };

  // The model the user picked for this job in BridgeLit wins (``model_chosen``); else a
  // model set in Connect; else the one BridgeLit's own CLI uses (job.model, a suggestion).
  // A picked model the plan refuses fails the job: it is never swapped for another.
  const chosen = job.model_chosen ? String(job.model ?? "") : "";
  const own = chosen ? "" : options.models?.[job.provider];
  const suggested = chosen || own ? "" : String(job.model ?? "");
  const runWith = (model) =>
    run({
      provider: job.provider,
      system: job.system,
      prompt: job.prompt,
      // A picture for the AI to read with the prompt (a scanned page), if any.
      images: job.images,
      timeoutMs: Math.max(10, Number(job.timeout_seconds) || 240) * 1000,
      model,
      keepApiKeys: options.keepApiKeys,
      onPartial,
      signal: stop.signal,
    });

  // Waits out a rate limit a few times; a longer or repeated one goes back to BridgeLit.
  const patient = async (model) => {
    for (let tries = 0; ; tries += 1) {
      try {
        return await runWith(model);
      } catch (error) {
        if (!(error instanceof RateLimited) || tries >= RATE_RETRIES || error.retryAfter > LOCAL_WAIT_MAX_S) {
          throw error;
        }
        log(`${error.message} Retrying in ${error.retryAfter}s…`);
        await sleep(error.retryAfter * 1000, stop.signal);
        if (stop.signal.aborted) throw error;
      }
    }
  };

  let body;
  try {
    let answer;
    try {
      answer = await patient(chosen || own || suggested || undefined);
    } catch (error) {
      if (!(suggested && error instanceof ProviderError && MODEL_REFUSED.test(error.message))) throw error;
      log(`${suggested} isn't on this plan; using ${LABELS[job.provider] ?? job.provider}'s default model.`);
      answer = await patient(undefined);
    }
    const reason = privateDataReason(answer);
    body = reason
      ? { error: `Answer withheld on the computer: ${reason}.` }
      : { answer: answer.slice(0, job.max_answer_chars) };
  } catch (error) {
    if (stop.signal.aborted && pending && privateDataReason(pending)) {
      body = { error: "Answer withheld on the computer: it looked like private data." };
    } else if (error instanceof RateLimited) {
      // Not a failure: BridgeLit queues the job again after ``retry_after``.
      body = { error: error.message, retry_after: error.retryAfter };
    } else if (error instanceof ToolAttempt) {
      body = { error: `${error.message} The answer was discarded for safety.` };
    } else if (error instanceof ProviderError) {
      body = { error: error.message };
    } else {
      body = { error: "Something went wrong on the computer." };
    }
  }
  try {
    await api.result(job.id, body);
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 409)) throw error;
  }
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  log(
    body.answer
      ? `Answered in ${seconds}s.`
      : body.retry_after
        ? `${body.error} BridgeLit will send it again in ${body.retry_after}s.`
        : `Not answered: ${body.error}`,
  );
}

/**
 * Stay connected until ``signal`` aborts.
 * @param {import("./api.js").Api} api
 */
export async function runAgent(api, options, log, signal) {
  let found = detect();
  let providers = readyProviders(found);
  let lastHello = 0;
  let lastDetect = Date.now();
  let failures = 0;
  let firstHello = true;
  const info = () => ({
    providers,
    image_providers: imageProviders(providers),
    agent_version: VERSION,
    platform: `${process.platform}-${process.arch}`,
    name: os.hostname(),
  });

  for (const p of Object.keys(found)) {
    const f = found[p];
    log(`${LABELS[p]}: ${f.ready ? `ready (${f.version})` : f.installed ? `not ready - ${f.note}` : p.endsWith("_api") ? f.note : "not installed"}`);
  }
  if (providers.length === 0) {
    log("No AI is ready on this computer. Run `bridgelit-connect doctor` for help.");
  }

  // Jobs running now; up to ``parallelLimit`` at once (the server never hands more).
  const inflight = new Set();
  let serverMax = 1;
  const startJob = (job) => {
    const handler = job.kind === "image" ? handleImageJob : handleJob;
    const task = handler(api, job, options, log)
      .catch((error) => log(`Couldn't send the answer back (${error.message}).`))
      .finally(() => inflight.delete(task));
    inflight.add(task);
  };

  while (!signal.aborted) {
    try {
      if (inflight.size >= parallelLimit(serverMax, options)) {
        const timedOut = await Promise.race([
          Promise.race(inflight).then(() => false),
          sleep(BUSY_HELLO_MS, signal).then(() => true),
        ]);
        if (timedOut && !signal.aborted) {
          await api.hello(info());
          lastHello = Date.now();
        }
        continue;
      }
      if (Date.now() - lastDetect > DETECT_EVERY_MS) {
        found = detect();
        providers = readyProviders(found);
        lastDetect = Date.now();
        lastHello = 0;
      }
      if (Date.now() - lastHello > HELLO_EVERY_MS) {
        // The first hello tells BridgeLit this process just started, so jobs a
        // previous run left half done free their slots now.
        await api.hello(firstHello ? { ...info(), started: true } : info());
        firstHello = false;
        if (lastHello === 0 && failures === 0) log("Connected. Waiting for questions from BridgeLit… (Ctrl+C to stop)");
        lastHello = Date.now();
      }
      const { data } = await api.nextJob();
      if (failures > 0) log("Reconnected.");
      failures = 0;
      // Servers before parallel jobs send no limit: one at a time, as before.
      serverMax = Number(data?.max_parallel) || 1;
      if (data?.job) {
        startJob(data.job);
        continue;
      }
      await sleep(Math.max(1000, Number(data?.next_poll_ms) || 2000), signal);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        throw new RevokedError(error.message);
      }
      failures += 1;
      const wait = error instanceof ApiError && error.status === 429 ? 30_000 : backoff(failures);
      if (failures === 1 || failures % 10 === 0) {
        log(`Can't reach BridgeLit (${error.message}). Retrying in ${Math.round(wait / 1000)}s…`);
      }
      await sleep(wait, signal);
    }
  }
  await Promise.allSettled(inflight);
}

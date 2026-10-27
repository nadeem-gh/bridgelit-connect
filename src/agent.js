// The loop that keeps this computer connected: ask the server for work every
// couple of seconds, run each job through the local AI, send the answer back.
import os from "node:os";
import readline from "node:readline/promises";
import { ApiError } from "./api.js";
import { VERSION } from "./config.js";
import { privateDataReason } from "./guard.js";
import { LABELS, ProviderError, ToolAttempt, detect, readyProviders, runProvider } from "./providers.js";

const HELLO_EVERY_MS = 60_000;
const DETECT_EVERY_MS = 5 * 60_000;
const PARTIAL_EVERY_MS = 700;
const MAX_BACKOFF_MS = 60_000;

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

/**
 * Run one job end to end; never throws for job failures (they are reported).
 * @param {import("./api.js").Api} api
 */
export async function handleJob(api, job, options, log, run = runProvider) {
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

  let body;
  try {
    const answer = await run({
      provider: job.provider,
      system: job.system,
      prompt: job.prompt,
      timeoutMs: Math.max(10, Number(job.timeout_seconds) || 240) * 1000,
      model: options.models?.[job.provider],
      keepApiKeys: options.keepApiKeys,
      onPartial,
      signal: stop.signal,
    });
    const reason = privateDataReason(answer);
    body = reason
      ? { error: `Answer withheld on the computer: ${reason}.` }
      : { answer: answer.slice(0, job.max_answer_chars) };
  } catch (error) {
    if (stop.signal.aborted && pending && privateDataReason(pending)) {
      body = { error: "Answer withheld on the computer: it looked like private data." };
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
  log(body.answer ? `Answered in ${seconds}s.` : `Not answered: ${body.error}`);
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
  const info = () => ({ providers, agent_version: VERSION, platform: `${process.platform}-${process.arch}`, name: os.hostname() });

  for (const p of Object.keys(found)) {
    const f = found[p];
    log(`${LABELS[p]}: ${f.ready ? `ready (${f.version})` : f.installed ? `not ready - ${f.note}` : "not installed"}`);
  }
  if (providers.length === 0) {
    log("No AI is ready on this computer. Run `bridgelit-connect doctor` for help.");
  }

  while (!signal.aborted) {
    try {
      if (Date.now() - lastDetect > DETECT_EVERY_MS) {
        found = detect();
        providers = readyProviders(found);
        lastDetect = Date.now();
        lastHello = 0;
      }
      if (Date.now() - lastHello > HELLO_EVERY_MS) {
        await api.hello(info());
        if (lastHello === 0 && failures === 0) log("Connected. Waiting for questions from BridgeLit… (Ctrl+C to stop)");
        lastHello = Date.now();
      }
      const { data } = await api.nextJob();
      if (failures > 0) log("Reconnected.");
      failures = 0;
      if (data?.job) {
        await handleJob(api, data.job, options, log);
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
}

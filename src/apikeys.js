// The user's own Anthropic or OpenAI API key, kept in this computer's keychain and
// used from here: BridgeLit never sees it. Answers are plain text requests with
// no tools, through the official SDKs.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { deleteToken, loadToken, saveToken } from "./credentials.js";
import { readConfig, writeConfig } from "./config.js";
import { ProviderError, RateLimited } from "./errors.js";

export const API_PROVIDERS = ["anthropic_api", "openai_api"];
export const API_LABELS = { anthropic_api: "Claude API key", openai_api: "OpenAI API key" };
export const DEFAULT_MODELS = { anthropic_api: "claude-opus-5-5", openai_api: "gpt-5.5" };
const MAX_OUTPUT_TOKENS = 16000;

const ACCOUNT = (provider) => `api-key:${provider}`;
const KEY_SHAPES = { anthropic_api: /^sk-ant-[A-Za-z0-9_-]{20,}$/, openai_api: /^sk-[A-Za-z0-9_-]{20,}$/ };

/** ``anthropic`` / ``claude`` / ``openai`` / ``chatgpt`` -> provider id, or null. */
export function apiProviderFor(name) {
  const n = String(name ?? "").toLowerCase();
  if (["anthropic", "claude", "anthropic_api"].includes(n)) return "anthropic_api";
  if (["openai", "chatgpt", "gpt", "openai_api"].includes(n)) return "openai_api";
  return null;
}

export function looksLikeKey(provider, key) {
  return KEY_SHAPES[provider]?.test(String(key ?? "").trim()) ?? false;
}

export function storedKey(provider) {
  const store = readConfig().api_keys?.[provider];
  return store ? loadToken(ACCOUNT(provider), store) : null;
}

export function keyedProviders() {
  return API_PROVIDERS.filter((p) => Boolean(storedKey(p)));
}

export function saveKey(provider, key) {
  const store = saveToken(ACCOUNT(provider), key.trim());
  const config = readConfig();
  writeConfig({ ...config, api_keys: { ...(config.api_keys ?? {}), [provider]: store } });
  return store;
}

export function removeKey(provider) {
  const config = readConfig();
  deleteToken(ACCOUNT(provider), config.api_keys?.[provider]);
  const { [provider]: _gone, ...rest } = config.api_keys ?? {};
  writeConfig({ ...config, api_keys: rest });
}

// Keys go only to the official hosts: a stray ANTHROPIC_BASE_URL / OPENAI_BASE_URL set
// for another tool must not receive them. BRIDGELIT_*_BASE_URL overrides (proxies, tests).
const BASE_URLS = {
  anthropic_api: () => process.env.BRIDGELIT_ANTHROPIC_BASE_URL || "https://api.anthropic.com",
  openai_api: () => process.env.BRIDGELIT_OPENAI_BASE_URL || "https://api.openai.com/v1",
};

function client(provider, key) {
  const options = { apiKey: key, maxRetries: 2, baseURL: BASE_URLS[provider]() };
  return provider === "anthropic_api" ? new Anthropic(options) : new OpenAI(options);
}

/** A short check that the key works (lists models; costs nothing). */
export async function checkKey(provider, key) {
  try {
    if (provider === "anthropic_api") await client(provider, key).models.list({ limit: 1 });
    else await client(provider, key).models.list();
    return null;
  } catch (error) {
    return keyError(provider, error);
  }
}

export function keyError(provider, error) {
  const label = API_LABELS[provider];
  if (error instanceof Anthropic.AuthenticationError || error instanceof OpenAI.AuthenticationError) {
    return `Your ${label} was rejected. Add it again with \`bridgelit-connect key add ${provider === "anthropic_api" ? "anthropic" : "openai"}\`.`;
  }
  if (error instanceof Anthropic.PermissionDeniedError || error instanceof OpenAI.PermissionDeniedError) {
    return `Your ${label} isn't allowed to use this model.`;
  }
  if (error instanceof Anthropic.NotFoundError || error instanceof OpenAI.NotFoundError) {
    return `That model isn't available to your ${label}. Pick another with --${provider === "anthropic_api" ? "anthropic" : "openai"}-model.`;
  }
  if (outOfCredit(error)) {
    return `Your ${label} has run out of credit. Add credit with ${provider === "anthropic_api" ? "Anthropic" : "OpenAI"}, then resume.`;
  }
  if (error instanceof Anthropic.RateLimitError || error instanceof OpenAI.RateLimitError) {
    return `Your ${label} hit its rate limit.`;
  }
  if (error instanceof Anthropic.APIConnectionError || error instanceof OpenAI.APIConnectionError) {
    return `Couldn't reach ${provider === "anthropic_api" ? "Anthropic" : "OpenAI"} from this computer.`;
  }
  return String(error?.message ?? error).slice(0, 280);
}

const DEFAULT_RETRY_AFTER = 30;

/** A 429 that waiting won't fix: the account has no credit or quota left. */
export function outOfCredit(error) {
  return error instanceof OpenAI.RateLimitError && error.code === "insufficient_quota";
}

/** Seconds the provider asked us to wait (``retry-after`` / ``retry-after-ms``), else 30. */
export function retryAfterSeconds(error, now = Date.now()) {
  const headers = error?.headers;
  const read = (name) =>
    typeof headers?.get === "function" ? headers.get(name) : headers?.[name] ?? headers?.[name.toLowerCase()];
  const ms = Number(read("retry-after-ms"));
  if (ms > 0) return Math.ceil(ms / 1000);
  const raw = read("retry-after");
  if (raw == null || raw === "") return DEFAULT_RETRY_AFTER;
  const secs = Number(raw);
  if (Number.isFinite(secs) && secs >= 0) return Math.ceil(secs);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(1, Math.ceil((at - now) / 1000)) : DEFAULT_RETRY_AFTER;
}

async function runAnthropic({ key, model, system, prompt, onPartial, signal }) {
  const stream = client("anthropic_api", key).beta.messages.stream(
    {
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      messages: [{ role: "user", content: prompt }],
      // A declined request is re-run on Anthropic's recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    },
    { signal },
  );
  let text = "";
  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      text += event.delta.text;
      onPartial?.(text);
    }
  }
  const message = await stream.finalMessage();
  if (message.stop_reason === "refusal") {
    throw new ProviderError("Claude declined to answer this question.");
  }
  const answer = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  return answer || text;
}

async function runOpenAI({ key, model, system, prompt, onPartial, signal }) {
  const stream = await client("openai_api", key).chat.completions.create(
    {
      model,
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      stream: true,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
    },
    { signal },
  );
  let text = "";
  for await (const chunk of stream) {
    const piece = chunk.choices?.[0]?.delta?.content;
    if (piece) {
      text += piece;
      onPartial?.(text);
    }
  }
  return text;
}

/**
 * Answer one job with the stored API key. Resolves with the text; rejects with ProviderError.
 * @param {{provider: string, system: string, prompt: string, timeoutMs: number, model?: string,
 *          onPartial?: (text: string) => void, signal?: AbortSignal}} job
 */
export async function runApiProvider(job, keyFor = storedKey) {
  const key = keyFor(job.provider);
  if (!key) throw new ProviderError(`No ${API_LABELS[job.provider]} on this computer.`);
  const signal = AbortSignal.any(
    [AbortSignal.timeout(job.timeoutMs), job.signal].filter(Boolean),
  );
  const run = job.provider === "anthropic_api" ? runAnthropic : runOpenAI;
  try {
    const answer = await run({ ...job, key, model: job.model || DEFAULT_MODELS[job.provider], signal });
    if (!answer.trim()) throw new ProviderError(`${API_LABELS[job.provider]}: empty answer.`);
    return answer.trim();
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (signal.aborted) {
      throw new ProviderError(job.signal?.aborted ? "Stopped." : "The AI took too long and was stopped.");
    }
    if (
      !outOfCredit(error) &&
      (error instanceof Anthropic.RateLimitError || error instanceof OpenAI.RateLimitError)
    ) {
      throw new RateLimited(keyError(job.provider, error), retryAfterSeconds(error));
    }
    throw new ProviderError(keyError(job.provider, error));
  }
}

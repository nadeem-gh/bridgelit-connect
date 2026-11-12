// The user's own Anthropic, OpenAI or Gemini API key, kept in this computer's
// keychain and used from here: BridgeLit never sees it. Answers are plain text
// requests with no tools, through the official SDKs (Gemini: its REST API).
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { deleteToken, loadToken, saveToken } from "./credentials.js";
import { readConfig, writeConfig } from "./config.js";
import { ProviderError, RateLimited } from "./errors.js";

export const API_PROVIDERS = ["anthropic_api", "openai_api", "gemini_api"];
export const API_LABELS = { anthropic_api: "Claude API key", openai_api: "OpenAI API key", gemini_api: "Gemini API key" };
export const DEFAULT_MODELS = { anthropic_api: "claude-opus-5-5", openai_api: "gpt-5.5", gemini_api: "gemini-3.1-pro-preview" };
// What `key add …` calls each one, and who issues it.
export const KEY_NAMES = { anthropic_api: "anthropic", openai_api: "openai", gemini_api: "gemini" };
const VENDORS = { anthropic_api: "Anthropic", openai_api: "OpenAI", gemini_api: "Google" };
const MAX_OUTPUT_TOKENS = 16000;

const ACCOUNT = (provider) => `api-key:${provider}`;
const KEY_SHAPES = {
  anthropic_api: /^sk-ant-[A-Za-z0-9_-]{20,}$/,
  openai_api: /^sk-[A-Za-z0-9_-]{20,}$/,
  // AI Studio keys (AIza…, 39 characters); newer formats are longer.
  gemini_api: /^[A-Za-z0-9_.-]{35,}$/,
};

/** ``anthropic`` / ``claude`` / ``openai`` / ``chatgpt`` / ``gemini`` / ``google`` -> provider id, or null. */
export function apiProviderFor(name) {
  const n = String(name ?? "").toLowerCase();
  if (["anthropic", "claude", "anthropic_api"].includes(n)) return "anthropic_api";
  if (["openai", "chatgpt", "gpt", "openai_api"].includes(n)) return "openai_api";
  if (["gemini", "google", "gemini_api"].includes(n)) return "gemini_api";
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
  gemini_api: () => process.env.BRIDGELIT_GEMINI_BASE_URL || "https://generativelanguage.googleapis.com",
};

/** A failed Gemini REST call: HTTP status, Google's status name, and any retry delay. */
export class GeminiError extends Error {
  constructor(status, code, message, retryAfter = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

/** ``"30s"`` / ``"1.5s"`` (RetryInfo.retryDelay) -> whole seconds, or null. */
export function geminiRetryDelay(details) {
  for (const d of Array.isArray(details) ? details : []) {
    const m = /^(\d+(?:\.\d+)?)s$/.exec(String(d?.retryDelay ?? ""));
    if (m) return Math.max(1, Math.ceil(Number(m[1])));
  }
  return null;
}

async function geminiFetch(key, pathAndQuery, { body, signal } = {}) {
  const response = await fetch(`${BASE_URLS.gemini_api()}${pathAndQuery}`, {
    method: body ? "POST" : "GET",
    headers: { "x-goog-api-key": key, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal,
  });
  if (!response.ok) {
    let data = {};
    try {
      data = await response.json();
    } catch {
      // not JSON: keep the status alone
    }
    const err = data.error ?? {};
    throw new GeminiError(
      response.status,
      String(err.status ?? ""),
      String(err.message ?? `HTTP ${response.status}`),
      geminiRetryDelay(err.details),
    );
  }
  return response;
}

/** The parts of the user message: the job's pictures (a scanned page) first, then the prompt. */
export function geminiParts(prompt, images) {
  return [
    ...(images ?? []).map((i) => ({ inlineData: { mimeType: i.media_type, data: i.data } })),
    { text: prompt },
  ];
}

/** The answer text of one streamed chunk (thoughts left out), and why it stopped. */
export function geminiChunk(data) {
  if (data?.promptFeedback?.blockReason) {
    throw new ProviderError("Gemini declined to answer this question.");
  }
  const candidate = data?.candidates?.[0] ?? {};
  const text = (candidate.content?.parts ?? [])
    .filter((part) => typeof part.text === "string" && !part.thought)
    .map((part) => part.text)
    .join("");
  return { text, finish: candidate.finishReason ?? "" };
}

const GEMINI_DECLINED = new Set(["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII"]);

async function runGemini({ key, model, system, prompt, images, onPartial, signal }) {
  const response = await geminiFetch(
    key,
    `/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`,
    {
      signal,
      body: {
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: "user", parts: geminiParts(prompt, images) }],
        generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
      },
    },
  );
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let finish = "";
  const take = (line) => {
    if (!line.startsWith("data:")) return;
    let data;
    try {
      data = JSON.parse(line.slice(5).trim());
    } catch {
      return;
    }
    const chunk = geminiChunk(data);
    if (chunk.finish) finish = chunk.finish;
    if (chunk.text) {
      text += chunk.text;
      onPartial?.(text);
    }
  };
  for await (const piece of response.body) {
    buffer += decoder.decode(piece, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      take(buffer.slice(0, index).trim());
      buffer = buffer.slice(index + 1);
    }
  }
  take(buffer.trim());
  if (!text && GEMINI_DECLINED.has(finish)) {
    throw new ProviderError("Gemini declined to answer this question.");
  }
  return text;
}

function client(provider, key) {
  if (provider === "gemini_api") throw new Error("Gemini has no SDK client here.");
  const options = { apiKey: key, maxRetries: 2, baseURL: BASE_URLS[provider]() };
  return provider === "anthropic_api" ? new Anthropic(options) : new OpenAI(options);
}

/** A short check that the key works (lists models; costs nothing). */
export async function checkKey(provider, key) {
  try {
    if (provider === "anthropic_api") await client(provider, key).models.list({ limit: 1 });
    else if (provider === "gemini_api") await geminiFetch(key, "/v1beta/models?pageSize=1");
    else await client(provider, key).models.list();
    return null;
  } catch (error) {
    return keyError(provider, error);
  }
}

function geminiKeyError(error) {
  const label = API_LABELS.gemini_api;
  if (!(error instanceof GeminiError)) {
    return error?.name === "TypeError" || error?.cause
      ? "Couldn't reach Google from this computer."
      : String(error?.message ?? error).slice(0, 280);
  }
  if (error.status === 401 || /API_KEY_INVALID|API key not valid|API key expired/i.test(error.message)) {
    return `Your ${label} was rejected. Add it again with \`bridgelit-connect key add gemini\`.`;
  }
  if (error.status === 403) return `Your ${label} isn't allowed to use this model.`;
  if (error.status === 404) {
    return "That model isn't available to your Gemini API key. Pick another with --gemini-api-model.";
  }
  if (outOfCredit(error)) {
    return `Your ${label} has run out of quota. Add billing in Google AI Studio, then resume.`;
  }
  if (error.status === 429) return `Your ${label} hit its rate limit.`;
  return error.message.slice(0, 280);
}

export function keyError(provider, error) {
  if (provider === "gemini_api") return geminiKeyError(error);
  const label = API_LABELS[provider];
  if (error instanceof Anthropic.AuthenticationError || error instanceof OpenAI.AuthenticationError) {
    return `Your ${label} was rejected. Add it again with \`bridgelit-connect key add ${KEY_NAMES[provider]}\`.`;
  }
  if (error instanceof Anthropic.PermissionDeniedError || error instanceof OpenAI.PermissionDeniedError) {
    return `Your ${label} isn't allowed to use this model.`;
  }
  if (error instanceof Anthropic.NotFoundError || error instanceof OpenAI.NotFoundError) {
    return `That model isn't available to your ${label}. Pick another with --${KEY_NAMES[provider]}-model.`;
  }
  if (outOfCredit(error)) {
    return `Your ${label} has run out of credit. Add credit with ${VENDORS[provider]}, then resume.`;
  }
  if (error instanceof Anthropic.RateLimitError || error instanceof OpenAI.RateLimitError) {
    return `Your ${label} hit its rate limit.`;
  }
  if (error instanceof Anthropic.APIConnectionError || error instanceof OpenAI.APIConnectionError) {
    return `Couldn't reach ${VENDORS[provider]} from this computer.`;
  }
  return String(error?.message ?? error).slice(0, 280);
}

const DEFAULT_RETRY_AFTER = 30;

/** A 429 that waiting won't fix: the account has no credit or quota left. */
export function outOfCredit(error) {
  if (error instanceof GeminiError) {
    // A daily free-tier or billing quota, not a per-minute one.
    return error.status === 429 && /per ?day|billing|limit: 0\b/i.test(error.message);
  }
  return error instanceof OpenAI.RateLimitError && error.code === "insufficient_quota";
}

function rateLimited(error) {
  return (
    error instanceof Anthropic.RateLimitError ||
    error instanceof OpenAI.RateLimitError ||
    (error instanceof GeminiError && error.status === 429)
  );
}

/** Seconds the provider asked us to wait (``retry-after`` / ``retry-after-ms``), else 30. */
export function retryAfterSeconds(error, now = Date.now()) {
  if (error instanceof GeminiError) return error.retryAfter ?? DEFAULT_RETRY_AFTER;
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

/** Pictures a job sends with its prompt (a scanned page): [{media_type, data}], checked. */
export function jobImages(images) {
  if (!Array.isArray(images)) return [];
  const allowed = new Set(["image/jpeg", "image/png", "image/webp"]);
  return images
    .filter((i) => i && allowed.has(i.media_type) && typeof i.data === "string" && i.data)
    .slice(0, 4);
}

/** The user message content: the prompt, with the job's pictures (a scanned page) first. */
function anthropicContent(prompt, images) {
  if (!images?.length) return prompt;
  return [
    ...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.media_type, data: i.data } })),
    { type: "text", text: prompt },
  ];
}

function openaiContent(prompt, images) {
  if (!images?.length) return prompt;
  return [
    ...images.map((i) => ({ type: "image_url", image_url: { url: `data:${i.media_type};base64,${i.data}` } })),
    { type: "text", text: prompt },
  ];
}

async function runAnthropic({ key, model, system, prompt, images, onPartial, signal }) {
  const stream = client("anthropic_api", key).beta.messages.stream(
    {
      model,
      max_tokens: MAX_OUTPUT_TOKENS,
      system,
      messages: [{ role: "user", content: anthropicContent(prompt, images) }],
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

async function runOpenAI({ key, model, system, prompt, images, onPartial, signal }) {
  const stream = await client("openai_api", key).chat.completions.create(
    {
      model,
      max_completion_tokens: MAX_OUTPUT_TOKENS,
      stream: true,
      messages: [
        { role: "system", content: system },
        { role: "user", content: openaiContent(prompt, images) },
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
  const run = { anthropic_api: runAnthropic, openai_api: runOpenAI, gemini_api: runGemini }[job.provider];
  if (!run) throw new ProviderError(`Unknown AI: ${job.provider}`);
  const images = jobImages(job.images);
  try {
    const answer = await run({ ...job, images, key, model: job.model || DEFAULT_MODELS[job.provider], signal });
    if (!answer.trim()) throw new ProviderError(`${API_LABELS[job.provider]}: empty answer.`);
    return answer.trim();
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (signal.aborted) {
      throw new ProviderError(job.signal?.aborted ? "Stopped." : "The AI took too long and was stopped.");
    }
    if (!outOfCredit(error) && rateLimited(error)) {
      throw new RateLimited(keyError(job.provider, error), retryAfterSeconds(error));
    }
    throw new ProviderError(keyError(job.provider, error));
  }
}

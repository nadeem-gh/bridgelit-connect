// Pictures for BridgeLit, made with the user's own AI on this computer:
// Codex's built-in image tool (their ChatGPT plan) or their OpenAI API key.
// Claude can't make pictures, so it never gets picture jobs.
//
// A picture job has a prompt and, to enhance, the picture to improve. The
// result goes back as base64; nothing else from this computer is sent.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import OpenAI, { toFile } from "openai";
import { storedKey } from "./apikeys.js";
import { ProviderError } from "./errors.js";

export const IMAGE_PROVIDERS = ["codex", "openai_api"];
export const DEFAULT_IMAGE_MODEL = "gpt-image-1";
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const CODEX_TOOL_ITEMS = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search", "tool_call"]);

export function codexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

/** Codex keeps each run's pictures under generated_images/<thread id>/. */
export function codexImagesDir(threadId, home = codexHome()) {
  return path.join(home, "generated_images", threadId);
}

/** The newest PNG/JPEG/WebP in ``dir``, or null. */
export function newestImage(dir) {
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f));
  } catch {
    return null;
  }
  if (files.length === 0) return null;
  const withTime = files.map((f) => {
    const full = path.join(dir, f);
    return { full, time: fs.statSync(full).mtimeMs };
  });
  withTime.sort((a, b) => b.time - a.time);
  return withTime[0].full;
}

function sniff(buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP") return "image/webp";
  return "";
}

function checked(buffer, who) {
  if (!buffer?.length || !sniff(buffer)) throw new ProviderError(`${who} didn't make a picture.`);
  if (buffer.length > MAX_IMAGE_BYTES) throw new ProviderError("The picture is too large to send.");
  return buffer.toString("base64");
}

export function imagePrompt(prompt, enhancing) {
  const ask = enhancing
    ? `Use your image generation tool to edit the attached picture: ${prompt}`
    : `Use your image generation tool to make one picture: ${prompt}`;
  return `${ask}\n\nMake exactly one picture. Do not run commands, read or write files, or browse. When the picture is done, reply with one short sentence.`;
}

export function codexImageArgs({ model, imagePath }) {
  const args = ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only"];
  if (model) args.push("--model", model);
  if (imagePath) args.push("--image", imagePath);
  args.push("--", "-");
  return args;
}

/** Reads `codex exec --json` lines for a picture run: the thread id, tool attempts, errors. */
export function codexImageParser() {
  let threadId = "";
  let error = null;
  return {
    line(raw) {
      let event;
      try {
        event = JSON.parse(raw);
      } catch {
        return;
      }
      if (event.type === "thread.started" && event.thread_id) threadId = String(event.thread_id);
      const item = event.item ?? {};
      if ((event.type === "item.started" || event.type === "item.completed") && CODEX_TOOL_ITEMS.has(item.type)) {
        throw new ProviderError(`Codex tried to use a tool (${item.type}); the picture was stopped for safety.`);
      }
      if (event.type === "error" || event.type === "turn.failed") {
        error = String(event.message ?? event.error?.message ?? "Codex failed.");
      }
    },
    result() {
      return { threadId, error };
    },
  };
}

/** One picture with Codex. Resolves with base64. */
export function runCodexImage(job, { cli = "codex", env = process.env, home = codexHome(), spawnImpl = spawn } = {}) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "bridgelit-img-"));
  let imagePath = null;
  if (job.input_image_b64) {
    const input = Buffer.from(job.input_image_b64, "base64");
    const type = sniff(input);
    if (!type) return Promise.reject(new ProviderError("The picture to enhance couldn't be read."));
    imagePath = path.join(workdir, `input.${type.split("/")[1].replace("jpeg", "jpg")}`);
    fs.writeFileSync(imagePath, input);
  }
  const parser = codexImageParser();
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = "";
    let buffer = "";
    const child = spawnImpl(cli, codexImageArgs({ model: job.model, imagePath }), {
      cwd: workdir,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      job.signal?.removeEventListener("abort", onAbort);
      if (child.exitCode === null) child.kill("SIGKILL");
      fs.rmSync(workdir, { recursive: true, force: true });
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(new ProviderError("Stopped."));
    const timer = setTimeout(() => finish(new ProviderError("Codex took too long to make the picture.")), job.timeoutMs);
    job.signal?.addEventListener("abort", onAbort);
    const feed = (raw) => {
      try {
        parser.line(raw);
      } catch (error) {
        finish(error);
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const raw = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (raw) feed(raw);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on("error", (error) =>
      finish(new ProviderError(error.code === "ENOENT" ? "Codex CLI is not installed." : error.message)),
    );
    child.on("close", (code) => {
      if (buffer.trim()) feed(buffer.trim());
      if (settled) return;
      const { threadId, error } = parser.result();
      if (error) return finish(new ProviderError(error.slice(0, 280)));
      const file = threadId ? newestImage(codexImagesDir(threadId, home)) : null;
      if (!file) {
        const why = code !== 0 && stderr ? ` (${stderr.trim().split("\n").pop().slice(0, 160)})` : "";
        return finish(
          new ProviderError(
            `Codex didn't make a picture${why}. Check that image generation is on: \`codex features enable image_generation\`.`,
          ),
        );
      }
      try {
        finish(null, checked(fs.readFileSync(file), "Codex"));
      } catch (e) {
        finish(e);
      }
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(imagePrompt(job.prompt, Boolean(imagePath)));
  });
}

/** One picture with the user's OpenAI API key. Resolves with base64. */
export async function runOpenAIImage(job, { keyFor = storedKey, makeClient } = {}) {
  const key = keyFor("openai_api");
  if (!key) throw new ProviderError("No OpenAI API key on this computer.");
  const openai =
    makeClient?.(key) ??
    new OpenAI({ apiKey: key, maxRetries: 1, baseURL: process.env.BRIDGELIT_OPENAI_BASE_URL || "https://api.openai.com/v1" });
  const signal = AbortSignal.any([AbortSignal.timeout(job.timeoutMs), job.signal].filter(Boolean));
  const model = job.imageModel || DEFAULT_IMAGE_MODEL;
  try {
    let response;
    if (job.input_image_b64) {
      const input = Buffer.from(job.input_image_b64, "base64");
      const type = sniff(input);
      if (!type) throw new ProviderError("The picture to enhance couldn't be read.");
      const image = await toFile(input, `input.${type.split("/")[1]}`, { type });
      response = await openai.images.edit({ model, image, prompt: job.prompt, n: 1 }, { signal });
    } else {
      response = await openai.images.generate({ model, prompt: job.prompt, n: 1, size: "auto" }, { signal });
    }
    const b64 = response?.data?.[0]?.b64_json;
    if (!b64) throw new ProviderError("OpenAI didn't send back a picture.");
    return checked(Buffer.from(b64, "base64"), "OpenAI");
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (signal.aborted) throw new ProviderError(job.signal?.aborted ? "Stopped." : "OpenAI took too long to make the picture.");
    if (error instanceof OpenAI.AuthenticationError) throw new ProviderError("Your OpenAI API key was rejected.");
    if (error instanceof OpenAI.RateLimitError) throw new ProviderError("Your OpenAI API key hit its rate or spending limit.");
    if (error instanceof OpenAI.BadRequestError) throw new ProviderError(`OpenAI refused the picture: ${String(error.message).slice(0, 200)}`);
    throw new ProviderError(String(error?.message ?? error).slice(0, 280));
  }
}

/** Run one picture job. Resolves with base64; rejects with ProviderError. */
export function runImage(job, deps = {}) {
  if (job.provider === "codex") return runCodexImage(job, deps.codex);
  if (job.provider === "openai_api") return runOpenAIImage(job, deps.openai);
  return Promise.reject(new ProviderError("This AI can't make pictures. Use ChatGPT (Codex) or an OpenAI API key."));
}

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { handleImageJob, imageProviders } from "../src/agent.js";
import { codexImageArgs, codexImageParser, imagePrompt, newestImage, runCodexImage, runImage, runOpenAIImage } from "../src/images.js";
import { ProviderError } from "../src/providers.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const quiet = () => undefined;

function fakeSpawn(lines, { home, threadId, write = true, code = 0 } = {}) {
  const calls = [];
  const spawnImpl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new PassThrough();
    child.exitCode = null;
    child.kill = () => undefined;
    let input = "";
    child.stdin.on("data", (d) => (input += d));
    child.stdin.on("end", () => {
      calls.at(-1).input = input;
      if (write && threadId) {
        const dir = path.join(home, "generated_images", threadId);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "exec-1.png"), PNG);
      }
      child.stdout.end(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
      setImmediate(() => {
        child.exitCode = code;
        child.emit("close", code);
      });
    });
    return child;
  };
  return { spawnImpl, calls };
}

test("codex image args attach the picture and end options before stdin", () => {
  assert.deepEqual(codexImageArgs({}), ["exec", "--json", "--skip-git-repo-check", "--sandbox", "read-only", "--", "-"]);
  assert.deepEqual(codexImageArgs({ imagePath: "/t/in.png" }).slice(-4), ["--image", "/t/in.png", "--", "-"]);
});

test("the parser keeps the thread id and stops tool use", () => {
  const p = codexImageParser();
  p.line(JSON.stringify({ type: "thread.started", thread_id: "abc" }));
  assert.equal(p.result().threadId, "abc");
  assert.throws(() => p.line(JSON.stringify({ type: "item.started", item: { type: "command_execution" } })), ProviderError);
});

test("prompt asks for one picture, or an edit when enhancing", () => {
  assert.match(imagePrompt("a mill", false), /make one picture: a mill/);
  assert.match(imagePrompt("sharper", true), /edit the attached picture: sharper/);
});

test("codex run returns the picture saved for its thread", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codexhome-"));
  const { spawnImpl, calls } = fakeSpawn([{ type: "thread.started", thread_id: "t1" }, { type: "turn.completed" }], {
    home,
    threadId: "t1",
  });
  const b64 = await runCodexImage(
    { provider: "codex", prompt: "a mill", input_image_b64: PNG.toString("base64"), timeoutMs: 5000 },
    { home, spawnImpl },
  );
  assert.deepEqual(Buffer.from(b64, "base64"), PNG);
  assert.ok(calls[0].args.includes("--image"));
  assert.match(calls[0].input, /edit the attached picture/);
  // The input copy lived in a temp folder that is gone now.
  assert.equal(fs.existsSync(calls[0].opts.cwd), false);
});

test("codex run without a saved picture explains how to turn images on", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codexhome-"));
  const { spawnImpl } = fakeSpawn([{ type: "thread.started", thread_id: "t2" }], { home, threadId: "t2", write: false });
  await assert.rejects(
    runCodexImage({ provider: "codex", prompt: "a mill", timeoutMs: 5000 }, { home, spawnImpl }),
    /image_generation/,
  );
});

test("codex run that answers in words shows what Codex said", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "codexhome-"));
  const { spawnImpl } = fakeSpawn(
    [
      { type: "thread.started", thread_id: "t3" },
      { type: "item.completed", item: { type: "agent_message", text: "Please send the paragraph." } },
      { type: "turn.completed" },
    ],
    { home, threadId: "t3", write: false },
  );
  await assert.rejects(
    runCodexImage({ provider: "codex", prompt: "this paragraph", timeoutMs: 5000 }, { home, spawnImpl }),
    (e) => /answered instead of drawing: "Please send the paragraph\."/.test(e.message) && !/image_generation/.test(e.message),
  );
});

test("newestImage ignores other files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imgs-"));
  fs.writeFileSync(path.join(dir, "notes.txt"), "x");
  assert.equal(newestImage(dir), null);
  fs.writeFileSync(path.join(dir, "a.png"), PNG);
  assert.equal(newestImage(dir), path.join(dir, "a.png"));
  assert.equal(newestImage(path.join(dir, "missing")), null);
});

test("openai key generates, or edits when given a picture", async () => {
  const seen = [];
  const makeClient = () => ({
    images: {
      generate: async (body) => {
        seen.push(["generate", body]);
        return { data: [{ b64_json: PNG.toString("base64") }] };
      },
      edit: async (body) => {
        seen.push(["edit", body]);
        return { data: [{ b64_json: PNG.toString("base64") }] };
      },
    },
  });
  const keyFor = () => "sk-test";
  await runOpenAIImage({ prompt: "a mill", timeoutMs: 5000 }, { keyFor, makeClient });
  await runOpenAIImage({ prompt: "sharper", timeoutMs: 5000, input_image_b64: PNG.toString("base64") }, { keyFor, makeClient });
  assert.deepEqual(
    seen.map(([k, b]) => [k, b.model, b.prompt]),
    [
      ["generate", "gpt-image-1", "a mill"],
      ["edit", "gpt-image-1", "sharper"],
    ],
  );
});

test("openai answer that isn't a picture is refused", async () => {
  const makeClient = () => ({ images: { generate: async () => ({ data: [{ b64_json: Buffer.from("hi").toString("base64") }] }) } });
  await assert.rejects(runOpenAIImage({ prompt: "x", timeoutMs: 5000 }, { keyFor: () => "k", makeClient }), /didn't make a picture/);
});

test("claude can't make pictures", async () => {
  await assert.rejects(runImage({ provider: "claude", prompt: "x" }), /can't make pictures/);
  assert.deepEqual(imageProviders(["claude", "codex", "anthropic_api", "openai_api"]), ["codex", "openai_api"]);
});

test("image job sends the picture, or the error", async () => {
  const calls = [];
  const api = { result: async (id, body) => calls.push([id, body]) };
  const job = { id: 3, kind: "image", provider: "codex", prompt: "a mill", timeout_seconds: 60 };
  await handleImageJob(api, job, {}, quiet, async () => "AAAA");
  await handleImageJob(api, job, {}, quiet, async () => {
    throw new ProviderError("Usage limit");
  });
  assert.deepEqual(calls, [
    [3, { image_b64: "AAAA" }],
    [3, { error: "Usage limit" }],
  ]);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { connectPages, normalizeServer } from "../src/config.js";
import { parseArgs } from "../src/cli.js";

test("server must be https except on localhost", () => {
  assert.equal(normalizeServer(undefined), "https://bridgelit.net");
  assert.equal(normalizeServer("https://bridgelit.net/some/path"), "https://bridgelit.net");
  assert.equal(normalizeServer("http://localhost:8000"), "http://localhost:8000");
  assert.throws(() => normalizeServer("http://bridgelit.net"), /https/);
  assert.throws(() => normalizeServer("nonsense"), /valid/);
});

test("connect pages follow the server", () => {
  assert.deepEqual(connectPages("https://www.bridgelit.net"), {
    reader: "https://read.bridgelit.net/connect",
    author: "https://author.bridgelit.net/connect",
  });
  assert.equal(connectPages("http://localhost:8000").reader, "http://localhost:3100/connect");
});

test("argument parsing", () => {
  const args = parseArgs(["login", "--server", "http://localhost:8000", "--approve", "--name=Desk"]);
  assert.deepEqual(args._, ["login"]);
  assert.equal(args.server, "http://localhost:8000");
  assert.equal(args.approve, true);
  assert.equal(args.name, "Desk");
});

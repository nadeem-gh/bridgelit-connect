import assert from "node:assert/strict";
import { test } from "node:test";
import { privateDataReason } from "../src/guard.js";

test("normal answers pass", () => {
  assert.equal(privateDataReason("The author compares the river to time [1]."), null);
  assert.equal(privateDataReason("مصنف دریا کو وقت سے تشبیہ دیتا ہے [1]"), null);
});

test("keys, tokens and home folders are held back", () => {
  const who = { home: "/Users/sam" };
  for (const text of [
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "key AKIAABCDEFGHIJKLMNOP",
    `token ghp_${"a".repeat(36)}`,
    `sk-ant-${"x".repeat(30)}`,
    "see /Users/sam/notes.txt",
    "/home/bob/.ssh/id_ed25519",
    `blc_${"y".repeat(30)}`,
  ]) {
    assert.ok(privateDataReason(text, who), text);
  }
});

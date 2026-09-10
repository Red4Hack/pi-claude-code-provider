import assert from "node:assert/strict";
import test from "node:test";
import { headText, tailText } from "../../src/text.ts";

test("tail capture keeps the most recent characters within its bound", () => {
  assert.equal(tailText("", "abc", 5), "abc");
  assert.equal(tailText("abc", Buffer.from("de"), 5), "abcde");
  assert.equal(tailText("abcde", "fg", 5), "cdefg");
  // The bound holds no matter how large a single chunk is.
  assert.equal(tailText("abc", "x".repeat(50), 5), "xxxxx");
  assert.equal(tailText("abc", "", 5), "abc");
});

test("head capture keeps the earliest characters and stops growing at its bound", () => {
  assert.equal(headText("", Buffer.from("abc"), 5), "abc");
  assert.equal(headText("abc", "de", 5), "abcde");
  assert.equal(headText("abcde", "fg", 5), "abcde");
  assert.equal(headText("ab", "cdefgh", 5), "abcde");
});

test("both accumulators decode multi-byte chunks as UTF-8", () => {
  assert.equal(tailText("", Buffer.from("héllo", "utf8"), 10), "héllo");
  assert.equal(headText("", Buffer.from("héllo", "utf8"), 10), "héllo");
});

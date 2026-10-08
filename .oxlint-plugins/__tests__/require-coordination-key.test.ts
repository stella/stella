import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects only key positions for single and multi-key commands", async () => {
  expect(
    await lintSingleRule(
      "require-coordination-key",
      `redis.send("set", ["raw", "value"]);
redis.send("MGET", [coordinationKey(scope), "raw", \`raw:\${id}\`]);`,
    ),
  ).toEqual([1, 2, 2]);
});

test("reads declared script keys without confusing scripts or arguments with keys", async () => {
  expect(
    await lintSingleRule(
      "require-coordination-key",
      `redis.send("EVAL", ["script", "2", "first", "second", "argument"]);
redis.send("FCALL_RO", ["function", "1", \`raw:\${id}\`, "argument"]);`,
    ),
  ).toEqual([1, 1, 2]);
});

test("polices the first script key when numkeys is opaque", async () => {
  expect(
    await lintSingleRule(
      "require-coordination-key",
      'redis.send("EVALSHA", [sha, keyCount, "raw", "argument"]);',
    ),
  ).toEqual([1]);
});

test("accepts built keys literal values and commands with no key positions", async () => {
  expect(
    await lintSingleRule(
      "require-coordination-key",
      'redis.send("SET", [coordinationKey(scope), "value"]);\nredis.send("EVAL", ["script", "1", coordinationKey(scope), "argument"]);\nredis.send("PING", ["message"]);',
    ),
  ).toEqual([]);
});

test("exempts only the shared key-builder module", async () => {
  expect(
    await lintSingleRule(
      "require-coordination-key",
      'redis.send("GET", ["raw"]);',
      { sourcePath: "apps/api/src/lib/redis-keys.ts" },
    ),
  ).toEqual([]);
});

test("does not exempt a key-builder basename in another directory", async () => {
  expect(
    await lintSingleRule(
      "require-coordination-key",
      'redis.send("GET", ["raw"]);',
      { sourcePath: "apps/api/src/other/redis-keys.ts" },
    ),
  ).toEqual([1]);
});

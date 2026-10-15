import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const SCRIPT_COMMANDS = ["EVAL", "EVALSHA", "FCALL", "FCALL_RO"];

const scriptCalls = (argumentsSource: string) =>
  SCRIPT_COMMANDS.map(
    (command) => `redis.send("${command}", ["script", ${argumentsSource}]);`,
  ).join("\n");

test("accepts literal and template arguments when scripts declare zero keys", async () => {
  expect(
    await lintSingleRule(
      "require-coordination-key",
      scriptCalls(`"0", "argument", \`argument:\${id}\``),
    ),
  ).toEqual([]);
});

test("reports exactly the declared script keys", async () => {
  expect(
    await lintSingleRule(
      "require-coordination-key",
      scriptCalls(`"2", "first", \`second:\${id}\`, "argument"`),
    ),
  ).toEqual([1, 1, 2, 2, 3, 3, 4, 4]);
});

test("accepts built script keys without inspecting trailing arguments", async () => {
  expect(
    await lintSingleRule(
      "require-coordination-key",
      scriptCalls(
        `"1", coordinationKey(scope), "argument", \`argument:\${id}\``,
      ),
    ),
  ).toEqual([]);
});

test("still polices the first key when a script key count is opaque", async () => {
  expect(
    await lintSingleRule(
      "require-coordination-key",
      scriptCalls('keyCount, "key", "argument"'),
    ),
  ).toEqual([1, 2, 3, 4]);
});

test("does not treat malformed or unsafe key counts as known zero", async () => {
  for (const count of [
    "",
    " ",
    "-1",
    "-0",
    "+0",
    "00",
    "0x0",
    "0e0",
    "0.5",
    "NaN",
    "Infinity",
    "9007199254740992",
  ]) {
    expect(
      await lintSingleRule(
        "require-coordination-key",
        scriptCalls(`${JSON.stringify(count)}, "key", "argument"`),
      ),
    ).toEqual([1, 2, 3, 4]);
  }
});

import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const privateInputSource = [
  "declare const decision: unknown;",
  "declare const value: string;",
  "declare const body: unknown;",
  "JSON.stringify(decision);",
  "JSON.stringify(value);",
  "JSON.stringify(body);",
].join("\n");

test("treats submission bindings in the retry module as private input", async () => {
  expect(
    await lintSingleRule("no-secret-in-log-sink", privateInputSource, {
      sourcePath: "chat-secret-retry.ts",
    }),
  ).toEqual([4, 5, 6]);
});

test("leaves generic submission names alone in unrelated modules", async () => {
  expect(
    await lintSingleRule("no-secret-in-log-sink", privateInputSource, {
      sourcePath: "unrelated.ts",
    }),
  ).toEqual([]);
});

test("reports credential bindings in the retry module", async () => {
  expect(
    await lintSingleRule(
      "no-secret-in-log-sink",
      [
        "declare const secretDecision: unknown;",
        "declare const submittedCredential: string;",
        "JSON.stringify(secretDecision);",
        "JSON.stringify(submittedCredential);",
      ].join("\n"),
      { sourcePath: "chat-secret-retry.ts" },
    ),
  ).toEqual([3, 4]);
});

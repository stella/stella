import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

test("rejects missing, dynamic and malformed telemetry labels", async () => {
  expect(
    await lintSingleRule(
      "require-detached-label-shape",
      [
        "detached(save());",
        "detached(save(), label);",
        'detached(save(), "chatThread.save");',
        'detached(save(), "chat.save.retry");',
        'detached(save(), "chat-.save-");',
        `detached(save(), \`\${feature}.save\`);`,
        'detached(save(), "-.--");',
        'detached(save(), "chat--thread.save");',
        'detached(save(), "RouteComponent");',
      ].join("\n"),
    ),
  ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("allows stable dotted kebab labels and unrelated object methods", async () => {
  expect(
    await lintSingleRule(
      "require-detached-label-shape",
      [
        'detached(save(), "chat-thread.prefetch");',
        'detached(save(), "template-list.invalidate-templates");',
        'detached(save(), "oauth2-callback.exchange-code");',
        'queue.detached(save(), "RouteComponent");',
      ].join("\n"),
    ),
  ).toEqual([]);
});

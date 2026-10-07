import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("rejects raw attenuation on foreground and background utilities", async () => {
  expect(
    await lintSingleRule(
      "no-raw-foreground-opacity",
      'const classes = "text-muted-foreground/60";\nconst hover = "hover:text-foreground/80";\nconst fill = "bg-muted-foreground/50";',
    ),
  ).toEqual([1, 2, 3]);
});

test("rejects raw placeholder attenuation in template classes", async () => {
  expect(
    await lintSingleRule(
      "no-raw-foreground-opacity",
      `const classes = \`placeholder:text-muted-foreground/64 \${extra}\`;`,
    ),
  ).toEqual([1]);
});

test("accepts named attenuation tokens", async () => {
  expect(
    await lintSingleRule(
      "no-raw-foreground-opacity",
      'const classes = "text-foreground-muted placeholder:text-foreground-placeholder decoration-foreground-disabled border-foreground-disabled";',
    ),
  ).toEqual([]);
});

test("accepts opacity on unrelated color utilities", async () => {
  expect(
    await lintSingleRule(
      "no-raw-foreground-opacity",
      'const classes = "bg-warning/30 text-primary/80";',
    ),
  ).toEqual([]);
});

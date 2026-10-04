import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

describe.serial("transition result handling", () => {
  test("accepts returned and handled results through imported aliases", async () => {
    const source = [
      'import { transition as change } from "@/api/lib/db/transitions";',
      'import * as owner from "./transitions";',
      "const alias = change;",
      "async function forwarding() { return await alias(tx, spec, id, options); }",
      "async function handling() { const result = await owner.transition(tx, spec, id, options);",
      'if (result.type === "stale") { return result; }',
      "consume(result.row); }",
    ].join("\n");
    expect(
      await lintSingleRule("no-discarded-transition-result", source, {
        sourcePath: "apps/api/src/lib/db/caller.ts",
      }),
    ).toEqual([]);
  });
  test("rejects discarded results through named, namespace and const aliases", async () => {
    const source = [
      'import { transition as change } from "@/api/lib/db/transitions";',
      'import * as owner from "./transitions";',
      "const alias = change;",
      "await change(tx, spec, id, options);",
      "owner.transition(tx, spec, id, options);",
      "void alias(tx, spec, id, options);",
      "const ignored = void await change(tx, spec, id, options);",
      "const result = (await change(tx, spec, id, options), 1);",
      "const handled = await change(tx, spec, id, options);",
      "async function forwarding() { return await change(tx, spec, id, options); }",
      "async function shadow(change) { await change(tx, spec, id, options); }",
      "function transition() {} transition();",
    ].join("\n");
    expect(
      await lintSingleRule("no-discarded-transition-result", source, {
        sourcePath: "apps/api/src/lib/db/caller.ts",
      }),
    ).toEqual([4, 5, 6, 7, 8]);
  });
});

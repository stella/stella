import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const SOURCE = [
  'import { user } from "@/api/db/auth-schema";',
  "export const read = db.select().from(user);",
  "",
].join("\n");

const lint = async (
  sourcePath: string,
  allowedFiles?: readonly { file: string; reason: string }[],
) =>
  await lintSingleRule("no-unscoped-user-query", SOURCE, {
    plugin: "security-guards",
    ruleOptions: allowedFiles === undefined ? undefined : { allowedFiles },
    sourcePath,
  });

describe.serial("no-unscoped-user-query allowedFiles", () => {
  test("reports an unscoped read in a module that is not listed", async () => {
    expect(
      await lint("apps/api/src/lib/elsewhere.ts", [
        { file: "apps/api/src/lib/listed.ts", reason: "own account only" },
      ]),
    ).toEqual([2]);
  });

  test("accepts every query in a listed module", async () => {
    expect(
      await lint("apps/api/src/lib/listed.ts", [
        { file: "apps/api/src/lib/listed.ts", reason: "own account only" },
      ]),
    ).toEqual([]);
  });

  test("does not honour an entry without a reason", async () => {
    expect(
      await lint("apps/api/src/lib/listed.ts", [
        { file: "apps/api/src/lib/listed.ts", reason: " " },
      ]),
    ).toEqual([2]);
  });
});

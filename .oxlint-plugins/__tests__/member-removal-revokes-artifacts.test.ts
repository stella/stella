import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const lint = async (...lines: readonly string[]) =>
  await lintSingleRule(
    "member-removal-revokes-artifacts",
    [...lines, ""].join("\n"),
    { plugin: "auth-lifecycle", sourcePath: "auth.ts" },
  );

describe.serial("member-removal-revokes-artifacts", () => {
  test("reports organization hooks without a revoking before-removal hook", async () => {
    expect(
      await lint(
        "declare const db: { delete: (table: unknown) => unknown };",
        "declare const unrelatedTable: unknown;",
        "export const options = {",
        "  organizationHooks: {",
        "    afterRemoveMember: () => db.delete(unrelatedTable),",
        "  },",
        "};",
      ),
    ).toEqual([4]);
  });

  test("accepts a before-removal hook that removes the member with its artifacts", async () => {
    expect(
      await lint(
        'import { rootDb } from "@/api/db/root";',
        'import { removeOrganizationMemberWithAuthArtifacts as removeMember } from "@/api/lib/auth-artifacts";',
        "declare const scope: Parameters<typeof removeMember>[1];",
        "export const options = {",
        "  organizationHooks: {",
        "    beforeRemoveMember: async () => {",
        "      await rootDb.transaction(async (tx) => {",
        "        await removeMember(tx, scope);",
        "      });",
        "    },",
        "  },",
        "};",
      ),
    ).toEqual([]);
  });
});

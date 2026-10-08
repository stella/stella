import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

const RULE = "no-hand-rolled-role-set";

test("role sets spelled in production sources are reported", async () => {
  const source = [
    "declare const role: string;",
    "declare const sql: (s: TemplateStringsArray) => string;",
    'const a = role === "owner" || role === "admin";',
    'const b = role !== "admin" && role !== "member" && role !== "intern";',
    'const c = new Set(["admin", "external"]);',
    "const d = sql`WHERE m.role IN ('owner', 'admin')`;",
    "const e = \"role = ANY (ARRAY['owner'::text, 'admin'::text])\";",
    'const f = "owner" === role || role === "admin";',
    "export { a, b, c, d, e, f };",
    "",
  ].join("\n");
  expect(
    await lintSingleRule(RULE, source, { sourcePath: "apps/api/src/x.ts" }),
  ).toEqual([3, 4, 5, 6, 7, 8]);
});

test("single roles, other operands and named sets are not reported", async () => {
  const source = [
    "declare const role: string;",
    "declare const actorRole: string;",
    "declare const sets: readonly string[];",
    'const a = role === "owner";',
    'const b = role !== "owner" || actorRole === "owner";',
    "const c = sets.some((value) => value === role);",
    'const d = ["owner", "draft"];',
    "const e = \"WHERE m.role = 'owner'\";",
    'const f = role === "owner" || role === "owner";',
    "export { a, b, c, d, e, f };",
    "",
  ].join("\n");
  expect(
    await lintSingleRule(RULE, source, { sourcePath: "apps/web/src/x.ts" }),
  ).toEqual([]);
});

test("owning modules, tests and files outside src are out of scope", async () => {
  const source = 'export const roles = ["owner", "admin"];\n';
  for (const sourcePath of [
    "packages/permissions/src/index.ts",
    "packages/auth-model/src/contract.ts",
    "apps/api/src/lib/x.test.ts",
    "apps/api/src/tests/security/x.ts",
    "scripts/x.ts",
  ]) {
    expect(await lintSingleRule(RULE, source, { sourcePath })).toEqual([]);
  }
  expect(
    await lintSingleRule(RULE, source, { sourcePath: "packages/ui/src/x.ts" }),
  ).toEqual([1]);
});

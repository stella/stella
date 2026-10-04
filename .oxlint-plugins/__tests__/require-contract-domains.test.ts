import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);
const lint = async (
  source: string,
  sourcePath = "apps/web/src/fixture.tsx",
  ledger: { id: string; reason: string }[] = [],
) =>
  lintSingleRule("require-contract-domains", source, {
    sourcePath,
    ruleOptions: { ledger },
  });

describe.serial("contract domains", () => {
  test("reports copied domains and all web limit forms", async () => {
    expect(
      await lint(
        [
          'const STATUSES = ["draft", "sent"] as const;',
          "const form = v.pipe(v.string(), v.maxLength(200), v.minLength(1));",
          "const field = <input maxLength={200} />;",
          "const options = { max: 200, maxSize: 200, maxLength: 200 };",
        ].join("\n"),
      ),
    ).toEqual([1, 2, 2, 3, 4, 4, 4]);
  });
  test("accepts contract imports, aliases, typed declarations and derived limits", async () => {
    expect(
      await lint(
        [
          'import type { InvoiceStatus as Status } from "@stll/api-contract";',
          'import { LIMITS } from "@stll/api-contract/limits";',
          'const statuses = ["draft", "sent"] as const satisfies readonly Status[];',
          'const other: readonly Status[] = ["draft", "sent"] as const;',
          'const generic = ["draft", "sent"] as const satisfies ReadonlyArray<Status>;',
          "const form = v.maxLength(LIMITS.nameMaxLength);",
          "const field = <input maxLength={LIMITS.nameMaxLength} />;",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
  test("local or unconstrained satisfies cannot exempt a copied domain", async () => {
    expect(
      await lint(
        [
          'type Status = "draft" | "sent";',
          'const local = ["draft", "sent"] as const satisfies readonly Status[];',
          'const broad = ["draft", "sent"] as const satisfies readonly string[];',
          'const cast = ["draft", "sent"] as const as readonly Status[];',
        ].join("\n"),
      ),
    ).toEqual([2, 3, 4]);
  });
  test("type import exemptions follow scope and accept contract namespaces", async () => {
    expect(
      await lint(
        [
          'import type { InvoiceStatus } from "@stll/api-contract";',
          'import type * as Contract from "@stll/api-contract";',
          'const global = ["draft", "sent"] as const satisfies readonly Contract.InvoiceStatus[];',
          'function local() { type InvoiceStatus = "draft" | "sent"; const values = ["draft", "sent"] as const satisfies readonly InvoiceStatus[]; }',
        ].join("\n"),
      ),
    ).toEqual([4]);
  });
  test("shadowed array wrappers cannot weaken a contract constraint", async () => {
    expect(
      await lint(
        [
          'import type { InvoiceStatus } from "@stll/api-contract";',
          "type ReadonlyArray<T> = readonly string[];",
          "type Array<T> = string[];",
          'const first = ["unknown", "other"] as const satisfies ReadonlyArray<InvoiceStatus>;',
          'const second = ["unknown", "other"] as const satisfies Array<InvoiceStatus>;',
        ].join("\n"),
      ),
    ).toEqual([4, 5]);
  });
  test("reports MCP limits and accepts LIMITS", async () => {
    expect(
      await lint(
        [
          "v.maxLength(200);",
          "v.minLength(1);",
          "v.maxValue(20);",
          "v.minValue(1000);",
          "v.maxLength(LIMITS.nameMaxLength);",
          "v.minValue(LIMITS.yearMin);",
        ].join("\n"),
        "apps/api/src/mcp/fixture.ts",
      ),
    ).toEqual([1, 2, 3, 4]);
  });
  test("scopes the guard and ignores non-domains", async () => {
    expect(
      await lint(
        'const one = ["draft"] as const; const mixed = ["draft", 2] as const;',
      ),
    ).toEqual([]);
    expect(
      await lint(
        'const statuses = ["draft", "sent"] as const; v.maxLength(200);',
        "packages/ui/fixture.ts",
      ),
    ).toEqual([]);
  });
  test("reasoned sites survive line movement but extra and stale sites fail", async () => {
    const ledger = [
      {
        id: 'apps/web/src/fixture.tsx::STATUSES::domain:["draft","sent"]::1',
        reason: "UI-local presentation order.",
      },
    ];
    expect(
      await lint(
        '\n\nconst STATUSES = ["draft", "sent"] as const;',
        undefined,
        ledger,
      ),
    ).toEqual([]);
    expect(
      await lint(
        'const STATUSES = ["draft", "sent"] as const; const extra = ["draft", "sent"] as const;',
        undefined,
        ledger,
      ),
    ).toEqual([1]);
    expect(
      await lint("const STATUSES = [] as const;", undefined, ledger),
    ).toEqual([1]);
  });
});

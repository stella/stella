import { describe, expect, test } from "bun:test";

import { runSingleRule } from "./lint-single-rule.ts";

const RULE = "disabled-switch-needs-reason";
const lint = async (source: string): Promise<number[]> =>
  (await runSingleRule(RULE, source, { sourcePath: "surface.tsx" })).lines;

describe(RULE, () => {
  test.concurrent(
    "flags disabled Switch and SwitchField without disabledReason",
    async () => {
      const source = [
        "export const a = <Switch disabled />;",
        "export const b = <SwitchField disabled={locked} label='SSO' />;",
      ].join("\n");
      expect(await lint(source)).toEqual([1, 2]);
    },
  );

  test.concurrent(
    "allows disabled={false} and switches with disabledReason",
    async () => {
      const source = [
        "export const a = <Switch disabled={false} />;",
        "export const b = <Switch disabled={locked} disabledReason='Add a provider' />;",
        "export const c = <SwitchField disabled={locked} disabledReason={reason} label='SSO' />;",
        "export const d = <Switch />;",
      ].join("\n");
      expect(await lint(source)).toEqual([]);
    },
  );
});

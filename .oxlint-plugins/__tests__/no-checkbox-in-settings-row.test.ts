import { describe, expect, test } from "bun:test";

import { runSingleRule } from "./lint-single-rule.ts";

const RULE = "no-checkbox-in-settings-row";
const lint = async (source: string): Promise<number[]> =>
  (await runSingleRule(RULE, source, { sourcePath: "settings.tsx" })).lines;

describe(RULE, () => {
  test.concurrent("flags Checkbox inside SettingsRow", async () => {
    const source = [
      "<SettingsRow title='Caching'>",
      "  <Checkbox checked={on} />",
      "</SettingsRow>;",
    ].join("\n");
    expect(await lint(source)).toEqual([2]);
  });

  test.concurrent(
    "allows Switch inside SettingsRow and Checkbox outside SettingsRow",
    async () => {
      const source = [
        "<SettingsRow title='Caching'><Switch checked={on} /></SettingsRow>;",
        "<ListItem><Checkbox checked={selected} /></ListItem>;",
      ].join("\n");
      expect(await lint(source)).toEqual([]);
    },
  );
});

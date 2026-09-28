import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const lint = async (lines: readonly string[], sourcePath: string) =>
  await lintSingleRule("no-direct-lucide-import", [...lines, ""].join("\n"), {
    sourcePath,
  });

describe.serial("no-direct-lucide-import", () => {
  test("reports every way a call site reaches lucide directly", async () => {
    expect(
      await lint(
        [
          'import { BookOpenIcon } from "lucide-react";',
          'import type { LucideIcon } from "lucide-react";',
          'export { WandSparklesIcon } from "lucide-react";',
          'export const lazyIcons = import("lucide-react");',
          "export const icon: LucideIcon = BookOpenIcon;",
        ],
        "apps/web/src/components/chat/composer-plus-menu.tsx",
      ),
    ).toEqual([1, 2, 3, 4]);
  });

  test("accepts the shared icon module", async () => {
    expect(
      await lint(
        [
          'import { SkillIcon, type LucideIcon } from "@stll/ui/icons";',
          "export const icon: LucideIcon = SkillIcon;",
        ],
        "apps/web/src/components/chat/composer-plus-menu.tsx",
      ),
    ).toEqual([]);
  });

  test("lets the icon module itself re-export lucide", async () => {
    expect(
      await lint(
        ['export { BookOpenIcon as SkillIcon } from "lucide-react";'],
        "packages/ui/src/icons.ts",
      ),
    ).toEqual([]);
  });
});

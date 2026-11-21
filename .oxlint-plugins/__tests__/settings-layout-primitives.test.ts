import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule";

const SETTINGS_PAGE =
  "apps/web/src/routes/_protected.settings/-organization.planted.page.tsx";

test("rejects every load of the card and table modules on a settings page", async () => {
  expect(
    await lintSingleRule(
      "settings-layout-primitives",
      [
        'import { Frame, FramePanel } from "@stll/ui/frame";',
        'import { Frame as AliasFrame } from "@stll/ui/components/frame";',
        'import { Table as AliasTable } from "@stll/ui/components/table";',
        'import { Table, TableRow } from "@stll/ui/table";',
        'import { TableSkeletonRows } from "@stll/ui/table-shell";',
        'export { TableHead } from "@stll/ui/table";',
        'export * from "@stll/ui/frame";',
        'const lazy = import("@stll/ui/table-shell");',
      ].join("\n"),
      { cwd: "scratch", sourcePath: SETTINGS_PAGE },
    ),
  ).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
});

test("accepts the settings pieces, the list, and type-only table imports", async () => {
  expect(
    await lintSingleRule(
      "settings-layout-primitives",
      [
        'import { SettingsPanel, SettingsRow, SettingsSection } from "@stll/ui/settings";',
        'import { ListItemStatus } from "@stll/ui/list";',
        'import { ListItemSkeleton } from "@stll/ui/list-shell";',
        'import type { TableSkeletonRows } from "@stll/ui/table-shell";',
        'import { TableIcon } from "@stll/ui/icons";',
        'import { framed } from "@stll/ui/frame-tokens";',
      ].join("\n"),
      { cwd: "scratch", sourcePath: SETTINGS_PAGE },
    ),
  ).toEqual([]);
});

test("a page that compares values across columns keeps its table, never a card", async () => {
  expect(
    await lintSingleRule(
      "settings-layout-primitives",
      [
        'import { Table, TableRow } from "@stll/ui/table";',
        'import { TableSkeletonRows } from "@stll/ui/table-shell";',
        'import { Frame } from "@stll/ui/frame";',
      ].join("\n"),
      {
        cwd: "scratch",
        sourcePath:
          "apps/web/src/routes/_protected.settings/-organization.members.page.tsx",
      },
    ),
  ).toEqual([3]);
});

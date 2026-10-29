import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

const hiddenTriggerCases = [
  {
    title: "rejects the original sr-only trigger and imported aliases",
    source: [
      'import { MenuTrigger, DropdownMenuTrigger as Trigger } from "@stll/ui/menu";',
      'const a = <MenuTrigger nativeButton={false} render={<span className="sr-only" />} />;',
      "const b = <Trigger render={<span hidden />} />;",
      'const c = <MenuTrigger className="hidden" />;',
      'import * as Menus from "@stll/ui/menu";',
      "const d = <Menus.MenuTrigger render={<span hidden />} />;",
    ].join("\n"),
    lines: [2, 3, 4, 6],
  },
  {
    title: "allows the owned anchor and visible menu triggers",
    source: [
      'import { MenuTrigger, MenuAnchor } from "@stll/ui/menu";',
      "const a = <MenuAnchor />;",
      "const b = <MenuTrigger render={<button />} />;",
    ].join("\n"),
    lines: [],
  },
];

test.each(hiddenTriggerCases)("$title", async ({ source, lines }) => {
  expect(
    await lintSingleRule("require-menu-anchor", source, {
      plugin: "semantic-controls",
      sourcePath: "apps/web/src/source.tsx",
    }),
  ).toEqual(lines);
});

const iconLabelCases = [
  {
    title: "rejects generic icon labels and inline sort translations",
    source: [
      'const a = <Button aria-label={labels.add} size="icon-xs" />;',
      'const b = <MenuTrigger aria-label={t("common.edit")} render={<Button size="icon" />} />;',
      'const c = <WorkspaceSortChips labels={{ addSort: t("common.add") }} />;',
    ].join("\n"),
    lines: [1, 2, 3],
  },
  {
    title: "allows dedicated icon intent and text button generic verbs",
    source: [
      'const a = <Button aria-label={labels.addSort} size="icon-xs" />;',
      'const b = <Button size="sm">{t("common.add")}</Button>;',
      'const c = <WorkspaceSortChips labels={{ addSort: t("common.sort") }} />;',
    ].join("\n"),
    lines: [],
  },
];

test.each(iconLabelCases)("$title", async ({ source, lines }) => {
  expect(
    await lintSingleRule("require-specific-icon-label", source, {
      plugin: "semantic-controls",
      sourcePath: "packages/workspace-ui/src/source.tsx",
    }),
  ).toEqual(lines);
});

const contextTargetCases = [
  {
    title: "rejects marked handlers without a nearest-target check",
    source: [
      'import { containedEventHandler } from "@stll/ui/use-contained-handler";',
      'const a = <li data-context-menu-target="matter" onContextMenu={containedEventHandler((event) => { event.preventDefault(); openMatterMenu(); })} />;',
      'const b = <li data-context-menu-target="matter" onContextMenu={openMatterMenu} />;',
    ].join("\n"),
    lines: [2, 3],
  },
  {
    title: "accepts aliased predicates and stable local handlers",
    source: [
      'import { containedEventHandler, ownsContextMenuTarget as ownsTarget } from "@stll/ui/use-contained-handler";',
      'const a = <li data-context-menu-target="matter" onContextMenu={containedEventHandler((event) => { if (!ownsTarget(event)) return; openMatterMenu(); })} />;',
      "const handler = (event) => { if (!ownsTarget(event)) return; openMatterMenu(); };",
      'const b = <li data-context-menu-target="matter" onContextMenu={containedEventHandler(handler)} />;',
      'const c = <li data-context-menu-target="child" />;',
      "const d = <div onContextMenu={openMenu} />;",
    ].join("\n"),
    lines: [],
  },
  {
    title: "accepts namespace imports and a local helper that owns resolution",
    source: [
      'import * as containment from "@stll/ui/use-contained-handler";',
      "const ownedHandler = (action) => (event) => { if (!containment.ownsContextMenuTarget(event)) return; action(); };",
      'const a = <li data-context-menu-target="matter" onContextMenu={ownedHandler(openMatterMenu)} />;',
    ].join("\n"),
    lines: [],
  },
  {
    title: "rejects unrelated predicates and shadowed import names",
    source: [
      'import { ownsContextMenuTarget as importedPredicate } from "@stll/ui/use-contained-handler";',
      "const ownsContextMenuTarget = () => true;",
      'const a = <li data-context-menu-target="matter" onContextMenu={(event) => { if (!ownsContextMenuTarget(event)) return; openMatterMenu(); }} />;',
      'const Component = (importedPredicate) => <li data-context-menu-target="matter" onContextMenu={(event) => { if (!importedPredicate(event)) return; openMatterMenu(); }} />;',
    ].join("\n"),
    lines: [3, 4],
  },
];

test.each(contextTargetCases)("$title", async ({ source, lines }) => {
  expect(
    await lintSingleRule("require-context-menu-target", source, {
      plugin: "semantic-controls",
      sourcePath: "apps/web/src/source.tsx",
    }),
  ).toEqual(lines);
});

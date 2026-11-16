import { describe, expect, test } from "bun:test";

import {
  nativeEntries,
  type NativePatterns,
  nativeRuleName,
  NO_NATIVE_UI_PLUGIN,
} from "../no-native-ui-registry.ts";
import { runSingleRule } from "./lint-single-rule.ts";

const lint = async (module: string, source: string): Promise<number[]> =>
  (
    await runSingleRule(nativeRuleName(module), source, {
      plugin: NO_NATIVE_UI_PLUGIN,
      sourcePath: "surface.tsx",
    })
  ).lines;

// One statement per pattern a registry row lists, so every pattern of every
// generated rule is proven to report, from the registry itself.
const nativeStatements = (patterns: NativePatterns): string[] => [
  ...(patterns.elements ?? []).map((element) => `<${element} />;`),
  ...(patterns.roles ?? []).map((role) => `<div role="${role}" />;`),
  ...(patterns.inputTypes ?? []).flatMap((type) => [
    `<input type="${type}" />;`,
    `<Input type={flag ? "${type}" : "text"} />;`,
  ]),
  ...(patterns.attributes ?? []).map(
    ({ name, values }) => `<span ${name}="${values?.[0] ?? "auto"}" />;`,
  ),
];

// What product code renders instead, and the near misses every generated rule
// must leave alone.
const CLEAN_SOURCE = [
  "export const a = <Switch checked onCheckedChange={setOn} />;",
  'export const b = <MenuCheckboxItem checked variant="switch" />;',
  'export const c = <Input type="search" />;',
  'export const d = <input type="hidden" />;',
  'export const e = <input type="radio" />;',
  'export const f = <iframe title="Preview" />;',
  'export const g = <abbr title="Limited liability company">LLC</abbr>;',
  'export const h = <DialogHeader title="Rename" />;',
  'export const i = <div role="presentation" />;',
  'export const j = <Button type="submit">Save</Button>;',
  "export const l = <ul><li>Row</li></ul>;",
  'export const m = <Select><SelectItem value="a" /></Select>;',
  "export const n = <Input type={kind} />;",
  'export const o = <input type="date" />;',
  'export const p = <input type="file" />;',
  'export const q = <div aria-label="Toolbar" />;',
].join("\n");

const ENTRIES = nativeEntries();

describe.each(ENTRIES)(
  "no-native-ui/no-native-$module",
  ({ module, patterns }) => {
    test.concurrent(
      "reports every native pattern the registry lists",
      async () => {
        const statements = nativeStatements(patterns);
        expect(statements.length).toBeGreaterThan(0);
        expect(await lint(module, statements.join("\n"))).toEqual(
          statements.map((_, index) => index + 1),
        );
      },
    );

    test.concurrent(
      "leaves the design system and near misses alone",
      async () => {
        expect(await lint(module, CLEAN_SOURCE)).toEqual([]);
      },
    );
  },
);

describe("no-native-ui edge cases", () => {
  test.concurrent(
    "a design-system Button cast as a switch is a switch",
    async () => {
      const source = [
        "export const Billable = () => (",
        "  <Button",
        '    role="switch"',
        "    aria-checked={billable}",
        '    size="icon-xs"',
        "    onClick={toggle}",
        "  />",
        ");",
        'export const Either = <div role={on ? "switch" : "group"} />;',
      ].join("\n");
      expect(await lint("switch", source)).toEqual([3, 9]);
    },
  );

  test.concurrent(
    "each input type is reported by the rule that owns it",
    async () => {
      const source = [
        "<input />;",
        "<input type={kind} />;",
        '<input type="email" />;',
        "<input {...props} />;",
        '<input type="checkbox" />;',
        '<input type="number" />;',
        '<input type="password" />;',
        '<input type="file" />;',
      ].join("\n");
      expect(await lint("input", source)).toEqual([1, 2, 3, 4]);
    },
  );

  test.concurrent(
    "a title on an abbreviation or frame is not a tooltip",
    async () => {
      const source = [
        'export const a = <abbr title="Société anonyme">SA</abbr>;',
        'export const b = <iframe title="Preview" />;',
        "export const c = <button title={label} />;",
      ].join("\n");
      expect(await lint("tooltip", source)).toEqual([3]);
    },
  );
});

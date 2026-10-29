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
const webStatements = (patterns: NativePatterns): string[] => [
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

/** `TextInput[multiline]` rendered as the element it names. */
const reactNativeStatement = (selector: string): string => {
  const [component = selector, flag] = selector.replace("]", "").split("[");
  return flag === undefined ? `<${component} />;` : `<${component} ${flag} />;`;
};

const reactNativeComponents = (selectors: readonly string[]): string[] => [
  ...new Set(selectors.map((selector) => selector.split("[")[0] ?? selector)),
];

/**
 * A source holding every pattern a rule reports, one per line after an
 * import of the React Native components it names, and the lines expected.
 */
const nativeSource = ({
  patterns,
  reactNative,
}: {
  patterns: NativePatterns;
  reactNative: readonly string[];
}): { source: string; lines: number[] } => {
  const statements = [
    ...webStatements(patterns),
    ...reactNative.map(reactNativeStatement),
  ];
  const header = `import { ${reactNativeComponents(reactNative).join(", ")} } from "react-native";`;
  return {
    source: [header, ...statements].join("\n"),
    lines: statements.map((_, index) => index + 2),
  };
};

const ENTRIES = nativeEntries();

describe.each(ENTRIES)(
  "no-native-ui/no-native-$module",
  ({ module, patterns, reactNative }) => {
    test.concurrent(
      "reports every native pattern the registry lists",
      async () => {
        const { source, lines } = nativeSource({ patterns, reactNative });
        expect(lines.length).toBeGreaterThan(0);
        expect(await lint(module, source)).toEqual(lines);
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
    "a React Native component is reported only when imported from react-native",
    async () => {
      const source = [
        'import { Pressable as Touchable, View } from "react-native";',
        'import * as RN from "react-native";',
        'import { Pressable } from "react-native-gesture-handler";',
        "export const a = <Touchable onPress={go} />;",
        "export const b = <RN.TouchableOpacity onPress={go} />;",
        "export const c = <Pressable onPress={go} />;",
        "export const d = <View />;",
        "export const e = <Button onPress={go}>Save</Button>;",
        'export const f = <View accessibilityRole="button" />;',
      ].join("\n");
      expect(await lint("button", source)).toEqual([4, 5, 9]);
    },
  );

  test.concurrent(
    "a multi-line TextInput is the textarea's, a single-line one the input's",
    async () => {
      const source = [
        'import { TextInput } from "react-native";',
        "export const a = <TextInput />;",
        "export const b = <TextInput multiline />;",
        "export const c = <TextInput multiline={false} />;",
        "export const d = <TextInput multiline={grows} />;",
      ].join("\n");
      expect(await lint("input", source)).toEqual([2, 4]);
      expect(await lint("textarea", source)).toEqual([3, 5]);
    },
  );

  test.concurrent(
    "the design system's Text is not React Native's",
    async () => {
      const source = [
        'import { Text } from "@stll/ui/text";',
        'export const a = <Text variant="caption">Hi</Text>;',
      ].join("\n");
      expect(await lint("text", source)).toEqual([]);
    },
  );

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

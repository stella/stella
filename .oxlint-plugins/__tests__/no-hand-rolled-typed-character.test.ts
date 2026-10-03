import { describe, expect, setDefaultTimeout, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

setDefaultTimeout(20_000);

const lint = async (
  source: string,
  sourcePath = "apps/web/src/components/example.ts",
) =>
  await lintSingleRule("no-hand-rolled-typed-character", source, {
    sourcePath,
  });

describe("no-hand-rolled-typed-character", () => {
  test("rejects Alt or AltGraph reasoning around a typed-character test", async () => {
    expect(
      await lint(
        [
          "const isEditKey = (event: KeyboardEvent) =>",
          "  !event.altKey && !event.ctrlKey && event.key.length === 1;",
          "const triggerFor = (event: KeyboardEvent) => {",
          '  const altGraph = event.getModifierState("AltGraph");',
          "  if (event.metaKey || (!altGraph && event.altKey)) return null;",
          '  return "@" === event.key ? "context" : null;',
          "};",
          "function menuFor(event: KeyboardEvent) {",
          "  if (event.altKey) return null;",
          '  switch (event.key) { case "/": return "skills"; default: return null; }',
          "}",
        ].join("\n"),
      ),
    ).toEqual([1, 3, 8]);
  });

  test("rejects length vetoes and literal trigger sets", async () => {
    expect(
      await lint(
        [
          "const rejects = (event: KeyboardEvent) => !event.altKey && event.key.length !== 1;",
          'const accepts = (event: KeyboardEvent) => !event.altKey && ["@", "/"].includes(event.key);',
          'const command = (event: KeyboardEvent) => (event.metaKey || event.ctrlKey) && !event.altKey && ["c", "v"].includes(event.key);',
          'const named = (event: KeyboardEvent) => !event.altKey && ["Enter", "Tab"].includes(event.key);',
        ].join("\n"),
      ),
    ).toEqual([1, 2]);
  });

  test("leaves Mod shortcuts, named keys and nested handlers alone", async () => {
    expect(
      await lint(
        [
          "const isSelectAll = (event: KeyboardEvent) =>",
          '  !(event.metaKey || event.ctrlKey) || event.altKey || event.key !== "a"',
          "    ? false : true;",
          "const isCopy = (event: KeyboardEvent) =>",
          '  (event.metaKey || event.ctrlKey) && !event.altKey && event.key === "c";',
          "const accepts = (event: KeyboardEvent) =>",
          '  event.key === "Tab" && !event.altKey && !event.metaKey;',
          "const activates = (event: KeyboardEvent) =>",
          '  event.key === " " && !event.altKey;',
          "const outer = (event: KeyboardEvent) => {",
          "  const blocked = event.altKey;",
          '  return [blocked, () => event.key === "@"];',
          "};",
        ].join("\n"),
      ),
    ).toEqual([]);
  });

  test("does not take a Mod chord that is only part of a veto as a shortcut", async () => {
    expect(
      await lint(
        [
          "const isEditKey = (event: KeyboardEvent) =>",
          '  !(event.metaKey || event.ctrlKey || event.altKey) && event.key === "x";',
        ].join("\n"),
      ),
    ).toEqual([1]);
  });

  test("leaves the helper's own module alone", async () => {
    const source = [
      "export const typedCharacter = (event: KeyboardEvent) =>",
      "  event.altKey || event.key.length === 1 ? event.key : null;",
    ].join("\n");
    expect(
      await lint(source, "packages/ui/src/lib/typed-character.ts"),
    ).toEqual([]);
  });
});

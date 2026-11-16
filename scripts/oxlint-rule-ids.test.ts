import { expect, test } from "bun:test";

import { pluginScope, ruleCanonicalizer } from "./oxlint-rule-ids";

for (const scope of [
  "__proto__",
  "constructor",
  "toString",
  "hasOwnProperty",
  "custom-plugin",
  "1",
]) {
  test(`an unaliased plugin keeps its own scope ${scope}`, () => {
    expect(pluginScope(scope)).toBe(scope);
    const canonicalize = ruleCanonicalizer([
      { scope, value: "fixture", category: "correctness" },
    ]);
    expect(canonicalize("fixture")).toBe(`${scope}/fixture`);
    expect(canonicalize(`${scope}/fixture`)).toBe(`${scope}/fixture`);
  });
}

test("known aliases still resolve to the installed plugin scope", () => {
  expect(pluginScope("@typescript-eslint")).toBe("typescript");
  expect(pluginScope("jsx-a11y")).toBe("jsx_a11y");
  expect(pluginScope("react-hooks")).toBe("react");
});

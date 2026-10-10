import { describe, expect, test } from "bun:test";

import {
  SEVERITY,
  checkBaseline,
  compareSeverities,
  declaredBaseRules,
  effectiveBaseRules,
  flattenLayers,
  severityOf,
  shadowedDeclarations,
} from "./oxlint-effective-config.ts";
import type { RuleLayer } from "./oxlint-effective-config.ts";
import { ruleCanonicalizer } from "./oxlint-rule-ids.ts";
import type { BuiltinRule } from "./oxlint-rule-ids.ts";

const BUILTINS: BuiltinRule[] = [
  { scope: "eslint", value: "complexity", category: "pedantic" },
  { scope: "eslint", value: "no-debugger", category: "correctness" },
  { scope: "eslint", value: "no-nested-ternary", category: "style" },
  { scope: "eslint", value: "no-unused-vars", category: "correctness" },
  { scope: "unicorn", value: "no-nested-ternary", category: "style" },
  { scope: "oxc", value: "no-map-spread", category: "perf" },
  { scope: "oxc", value: "bad-comparison-sequence", category: "correctness" },
  { scope: "jsdoc", value: "check-tag-names", category: "correctness" },
  { scope: "jsdoc", value: "require-param", category: "pedantic" },
  { scope: "react", value: "jsx-key", category: "correctness" },
  { scope: "react", value: "no-danger", category: "restriction" },
  { scope: "react_perf", value: "jsx-no-new-object-as-prop", category: "perf" },
];
const canonical = ruleCanonicalizer(BUILTINS);

const layer = (
  name: string,
  rules: Record<string, unknown>,
  plugins: string[] = [],
): RuleLayer => ({ name, rules, plugins, categories: {} });

const declare = (layers: RuleLayer[]) =>
  declaredBaseRules({ layers, builtins: BUILTINS, canonical });

const severities = (layers: RuleLayer[]) =>
  Object.fromEntries(
    [...declare(layers).rules].map(([rule, { severity }]) => [rule, severity]),
  );

describe("severityOf", () => {
  test("reads config and print-config spellings, bare or with options", () => {
    expect(severityOf("off")).toBe(SEVERITY.off);
    expect(severityOf("allow")).toBe(SEVERITY.off);
    expect(severityOf(0)).toBe(SEVERITY.off);
    expect(severityOf(1)).toBe(SEVERITY.warn);
    expect(severityOf(["warn", { max: 3 }])).toBe(SEVERITY.warn);
    expect(severityOf("deny")).toBe(SEVERITY.error);
    expect(severityOf(["error", ["always"]])).toBe(SEVERITY.error);
    expect(severityOf("on")).toBeUndefined();
    expect(severityOf([])).toBeUndefined();
  });
});

describe("flattenLayers", () => {
  test("orders nested extends, then earlier extends, then the config", () => {
    const nested = { rules: { "no-debugger": "off" } };
    const first = { extends: [nested], rules: {}, plugins: ["jsdoc"] };
    const second = { rules: {}, categories: { perf: "error" } };
    const root = { extends: [first, second], rules: { complexity: "error" } };
    expect(flattenLayers(root, "root").map(({ name }) => name)).toEqual([
      "root > extends[0] > extends[0]",
      "root > extends[0]",
      "root > extends[1]",
      "root",
    ]);
    expect(flattenLayers(root, "root").at(1)?.plugins).toEqual(["jsdoc"]);
    expect(flattenLayers(root, "root").at(2)?.categories).toEqual({
      perf: "error",
    });
  });

  test("ignores a non-object config", () => {
    expect(flattenLayers("./preset.json", "root")).toEqual([]);
  });
});

describe("declaredBaseRules", () => {
  test("the extending config outranks its preset", () => {
    const rules = severities([
      layer("preset", { "oxc/no-map-spread": "off" }),
      layer("root", { "oxc/no-map-spread": "error" }),
    ]);
    expect(rules["oxc/no-map-spread"]).toBe(SEVERITY.error);
  });

  test("a later preset outranks an earlier one", () => {
    const rules = severities([
      layer("first", { complexity: "error" }),
      layer("second", { complexity: "off" }),
    ]);
    expect(rules["eslint/complexity"]).toBe(SEVERITY.off);
  });

  test("spellings of one rule merge across layers", () => {
    const declared = declare([
      layer("preset", { "eslint/complexity": "error" }),
      layer("root", { complexity: "off" }),
    ]);
    expect(declared.rules.get("eslint/complexity")).toEqual({
      severity: SEVERITY.off,
      layer: "root",
    });
    expect(declared.aliasConflicts).toEqual([]);
  });

  test("the typescript spelling of an adapted ESLint rule is invalid", () => {
    // oxlint configures the ESLint rule for both spellings without merging
    // them, so their precedence is undefined.
    const declared = declare([
      layer("preset", { "@typescript-eslint/no-unused-vars": "error" }),
      layer("root", { "no-unused-vars": "off" }),
    ]);
    expect(
      declared.invalidKeys.map(({ key, layer: name }) => [key, name]),
    ).toEqual([["@typescript-eslint/no-unused-vars", "preset"]]);
    expect(declared.rules.get("eslint/no-unused-vars")?.severity).toBe(
      SEVERITY.off,
    );
  });

  test("correctness warns for enabled plugins only", () => {
    const rules = severities([layer("preset", {}, ["eslint", "oxc"])]);
    expect(rules["eslint/no-debugger"]).toBe(SEVERITY.warn);
    expect(rules["oxc/bad-comparison-sequence"]).toBe(SEVERITY.warn);
    expect(rules["jsdoc/check-tag-names"]).toBeUndefined();
    expect(rules["react/jsx-key"]).toBeUndefined();
  });

  test("oxlint's default plugins count as enabled", () => {
    const rules = severities([layer("preset", {}, ["eslint"])]);
    expect(rules["oxc/bad-comparison-sequence"]).toBe(SEVERITY.warn);
  });

  test("plugin aliases enable their scope", () => {
    const rules = severities([
      layer("preset", { "react-perf/jsx-no-new-object-as-prop": "error" }, [
        "react-perf",
        "react",
      ]),
    ]);
    expect(rules["react_perf/jsx-no-new-object-as-prop"]).toBe(SEVERITY.error);
    expect(rules["react/jsx-key"]).toBe(SEVERITY.warn);
  });

  test("a category setting replaces the default and applies by category", () => {
    const rules = severities([
      {
        ...layer("preset", {}, ["eslint", "jsdoc"]),
        categories: { correctness: "error", pedantic: "warn" },
      },
      { ...layer("root", {}), categories: { pedantic: "off" } },
    ]);
    expect(rules["eslint/no-debugger"]).toBe(SEVERITY.error);
    expect(rules["jsdoc/require-param"]).toBe(SEVERITY.off);
    expect(rules["eslint/complexity"]).toBe(SEVERITY.off);
  });

  test("a rule of a plugin nobody enables stays declared", () => {
    const rules = severities([
      layer("preset", { "jsdoc/require-param": "error" }, ["eslint"]),
    ]);
    expect(rules["jsdoc/require-param"]).toBe(SEVERITY.error);
  });

  test("two spellings with different values in one layer are a conflict", () => {
    const declared = declare([
      layer("preset", { complexity: "error" }),
      layer("root", { complexity: "off", "eslint/complexity": ["error", 30] }),
    ]);
    expect(declared.aliasConflicts).toEqual([
      {
        rule: "eslint/complexity",
        layer: "root",
        keys: ["complexity", "eslint/complexity"],
      },
    ]);
    expect(declared.rules.has("eslint/complexity")).toBe(false);
  });

  test("two spellings with one value in one layer agree", () => {
    const declared = declare([
      layer("root", {
        complexity: ["error", 30],
        "eslint/complexity": ["error", 30],
      }),
    ]);
    expect(declared.aliasConflicts).toEqual([]);
    expect(declared.rules.get("eslint/complexity")?.severity).toBe(
      SEVERITY.error,
    );
  });

  test("an ambiguous bare key and a value without a severity are invalid", () => {
    const declared = declare([
      layer("root", {
        "no-map-spread": "error",
        "no-such-rule": "error",
        "no-debugger": "loud",
        "stella-lowercase/stella-lowercase": "error",
      }),
    ]);
    // `no-map-spread` names one built-in rule, so it resolves.
    expect(declared.rules.get("oxc/no-map-spread")?.severity).toBe(
      SEVERITY.error,
    );
    expect(declared.invalidKeys.map(({ key }) => key)).toEqual([
      "no-such-rule",
      "no-debugger",
    ]);
  });
});

describe("effectiveBaseRules", () => {
  test("reads print-config severities under canonical ids", () => {
    const effective = effectiveBaseRules(
      {
        plugins: ["oxc"],
        rules: {
          complexity: ["deny", [{ max: 30 }]],
          "oxc/no-map-spread": "deny",
          "react_perf/jsx-no-new-object-as-prop": "warn",
        },
      },
      canonical,
    );
    expect(effective).toEqual(
      new Map([
        ["eslint/complexity", SEVERITY.error],
        ["oxc/no-map-spread", SEVERITY.error],
        ["react_perf/jsx-no-new-object-as-prop", SEVERITY.warn],
      ]),
    );
  });

  test("rejects output without a rules object or with an unknown severity", () => {
    expect(effectiveBaseRules({ plugins: [] }, canonical)).toBeUndefined();
    expect(
      effectiveBaseRules({ rules: { complexity: "loud" } }, canonical),
    ).toBeUndefined();
  });
});

describe("replaced declarations", () => {
  test("record the rule-level severity a later layer changes", () => {
    const declared = declare([
      layer("core", { "oxc/no-map-spread": "off", complexity: "error" }),
      layer("library", { "oxc/no-map-spread": "error", complexity: "error" }),
      layer("root", { "oxc/no-map-spread": "error" }),
    ]);
    expect(declared.rules.get("oxc/no-map-spread")).toEqual({
      severity: SEVERITY.error,
      layer: "library",
    });
    expect(declared.replaced).toEqual(
      new Map([
        ["oxc/no-map-spread", { severity: SEVERITY.off, layer: "core" }],
      ]),
    );
    // Restating a severity keeps the layer that decided it.
    expect(declared.rules.get("eslint/complexity")?.layer).toBe("core");
  });

  test("ignore a category default a rule entry changes", () => {
    const declared = declare([
      layer("core", { "no-debugger": "error" }, ["eslint"]),
    ]);
    expect(declared.replaced.size).toBe(0);
  });
});

describe("shadowedDeclarations", () => {
  const declared = declare([
    layer("core", {
      "oxc/no-map-spread": "off",
      "jsdoc/require-param": "error",
      "react/no-danger": "error",
      complexity: "error",
    }),
    layer("library", {
      "oxc/no-map-spread": "error",
      "jsdoc/require-param": "off",
      "react/no-danger": "off",
      complexity: "off",
    }),
    layer("root", { "react/no-danger": "error" }),
  ]);

  test("reports a preset severity another preset replaces unseen", () => {
    // `react/no-danger` is restated by the visible layer and `complexity`
    // is named there literally, so neither is shadowed.
    expect(
      shadowedDeclarations({
        declared,
        visibleLayer: "root",
        visibleRules: new Set(["eslint/complexity"]),
      }),
    ).toEqual([
      {
        rule: "jsdoc/require-param",
        from: SEVERITY.error,
        to: SEVERITY.off,
        detail: "core replaced by library",
      },
      {
        rule: "oxc/no-map-spread",
        from: SEVERITY.off,
        to: SEVERITY.error,
        detail: "core replaced by library",
      },
    ]);
  });
});

describe("compareSeverities", () => {
  test("reports both directions and undeclared effective rules", () => {
    const declared = new Map([
      ["jsdoc/require-param", { severity: SEVERITY.error, layer: "preset" }],
      ["oxc/no-map-spread", { severity: SEVERITY.off, layer: "preset" }],
      ["eslint/complexity", { severity: SEVERITY.error, layer: "root" }],
    ]);
    const effective = new Map([
      ["oxc/no-map-spread", SEVERITY.error],
      ["eslint/complexity", SEVERITY.error],
      ["react/jsx-key", SEVERITY.warn],
    ]);
    expect(compareSeverities({ declared, effective, skip: new Set() })).toEqual(
      [
        {
          rule: "jsdoc/require-param",
          from: SEVERITY.error,
          to: SEVERITY.off,
          detail: "declared by preset",
        },
        {
          rule: "oxc/no-map-spread",
          from: SEVERITY.off,
          to: SEVERITY.error,
          detail: "declared by preset",
        },
        {
          rule: "react/jsx-key",
          from: SEVERITY.off,
          to: SEVERITY.warn,
          detail: "declared by nothing",
        },
      ],
    );
  });

  test("skips rules whose declaration is already reported", () => {
    const declared = new Map([
      ["eslint/complexity", { severity: SEVERITY.off, layer: "root" }],
    ]);
    const effective = new Map([["eslint/complexity", SEVERITY.error]]);
    expect(
      compareSeverities({
        declared,
        effective,
        skip: new Set(["eslint/complexity"]),
      }),
    ).toEqual([]);
  });
});

describe("checkBaseline", () => {
  const finding = {
    rule: "jsdoc/require-param",
    from: SEVERITY.error,
    to: SEVERITY.off,
    detail: "declared by preset",
  };

  test("accepts a recorded finding", () => {
    expect(
      checkBaseline([finding], {
        "jsdoc/require-param": {
          from: SEVERITY.error,
          to: SEVERITY.off,
          reason: "fixture",
        },
      }),
    ).toEqual({ unexpected: [], stale: [] });
  });

  test("rejects a finding recorded with other severities", () => {
    expect(
      checkBaseline([finding], {
        "jsdoc/require-param": {
          from: SEVERITY.error,
          to: SEVERITY.warn,
          reason: "fixture",
        },
      }),
    ).toEqual({ unexpected: [finding], stale: ["jsdoc/require-param"] });
  });

  test("reports an entry that no longer matches a finding", () => {
    expect(
      checkBaseline([], {
        "oxc/no-map-spread": {
          from: SEVERITY.off,
          to: SEVERITY.error,
          reason: "fixture",
        },
      }),
    ).toEqual({ unexpected: [], stale: ["oxc/no-map-spread"] });
  });
});

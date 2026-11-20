// Guard: every rule option in the lint configs is plain JSON. Oxlint passes
// options to JS plugins as JSON, and Bun's built-in linter, which reads these
// configs too, refuses to load a config whose options carry a function,
// `undefined` or another value with no JSON form.

import { expect, test } from "bun:test";

import repository from "../oxlint.config.ts";
import design from "../oxlint.design.config.ts";
import resultBoundary from "../oxlint.result-boundary.config.ts";
import tailwind from "../oxlint.tailwind.config.ts";
import { isRecord, readScopes, ruleOptions } from "./oxlint-config-scopes.ts";

const CONFIGS: Readonly<Record<string, unknown>> = {
  "oxlint.config.ts": repository,
  "oxlint.design.config.ts": design,
  "oxlint.result-boundary.config.ts": resultBoundary,
  "oxlint.tailwind.config.ts": tailwind,
};

/** The paths under `at` whose values have no JSON form. */
const nonJsonPaths = (value: unknown, at: string): string[] => {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return [];
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? [] : [at];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      nonJsonPaths(item, `${at}[${String(index)}]`),
    );
  }
  if (isRecord(value) && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.entries(value).flatMap(([key, item]) =>
      nonJsonPaths(item, `${at}.${key}`),
    );
  }
  return [at];
};

/** The rule options of a config, its overrides and every config it extends. */
const optionPaths = (config: unknown, name: string): string[] => {
  const parents =
    isRecord(config) && Array.isArray(config["extends"])
      ? config["extends"]
      : [];
  return [
    ...parents.flatMap((parent, index) =>
      optionPaths(parent, `${name} > extends[${String(index)}]`),
    ),
    ...readScopes(config).flatMap(({ scope, rules }) =>
      Object.entries(rules).flatMap(([rule, value]) =>
        nonJsonPaths(ruleOptions(value), `${name} [${scope}] ${rule}`),
      ),
    ),
  ];
};

test("flags option values that have no JSON form", () => {
  const config = {
    rules: { plain: ["error", { list: ["a", 1, true, null] }] },
    overrides: [
      {
        files: ["**/*.ts"],
        rules: {
          withFunction: ["error", { entries: [{ summary: () => "text" }] }],
          withPattern: ["error", /pattern/u],
        },
      },
    ],
  };
  expect(optionPaths(config, "fixture")).toEqual([
    "fixture [**/*.ts] withFunction[0].entries[0].summary",
    "fixture [**/*.ts] withPattern[0]",
  ]);
});

test.each(Object.entries(CONFIGS))(
  "%s passes only JSON rule options",
  (name, config) => {
    expect(optionPaths(config, name)).toEqual([]);
  },
);

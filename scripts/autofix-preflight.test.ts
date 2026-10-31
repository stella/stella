import { expect, test } from "bun:test";

import { decideAutofixPreflight } from "./autofix-preflight";

type DecisionFixture = {
  generatorSelected?: boolean;
  formatClean?: boolean;
  lintPaths?: string[];
  toolError?: boolean;
};

const decide = ({
  generatorSelected = false,
  formatClean = true,
  lintPaths = [],
  toolError = false,
}: DecisionFixture = {}) =>
  decideAutofixPreflight(
    { generatorSelected, formatPaths: ["./README.md"], lintPaths },
    {
      formatClean: () => {
        if (toolError) {
          throw new TypeError("formatter failed");
        }
        return formatClean;
      },
      lintClean: () => true,
    },
  );

test("clean format-only files skip the full fixer", () => {
  expect(decide()).toBe("skip");
});

test("one unformatted file runs the fixers", () => {
  expect(decide({ formatClean: false })).toBe("run");
});

test("a lint path that can have a safe-rule fix runs with the type graph", () => {
  expect(decide({ lintPaths: ["./source.ts"] })).toBe("run");
});

test("a selected generator runs the fixers", () => {
  expect(decide({ generatorSelected: true })).toBe("run");
});

test("a tool error fails closed and runs the fixers", () => {
  expect(decide({ toolError: true })).toBe("run");
});

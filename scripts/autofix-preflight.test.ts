import { expect, test } from "bun:test";

import { decideAutofixPreflight } from "./autofix-preflight";

type DecisionFixture = {
  generatorSelected?: boolean;
  formatClean?: boolean;
  lintClean?: boolean;
  lintPaths?: string[];
  toolError?: "format" | "lint";
};

const decide = ({
  generatorSelected = false,
  formatClean = true,
  lintClean = true,
  lintPaths = [],
  toolError,
}: DecisionFixture = {}) =>
  decideAutofixPreflight(
    { generatorSelected, formatPaths: ["./README.md"], lintPaths },
    {
      formatClean: () => {
        if (toolError === "format") {
          throw new TypeError("formatter failed");
        }
        return formatClean;
      },
      lintClean: () => {
        if (toolError === "lint") {
          throw new TypeError("linter failed");
        }
        return lintClean;
      },
    },
  );

test("clean format-only files skip the full fixer", () => {
  expect(decide()).toBe("skip");
});

test("one unformatted file runs the fixers", () => {
  expect(decide({ formatClean: false })).toBe("run");
});

test("a clean TypeScript path skips the full fixer", () => {
  expect(decide({ lintPaths: ["./source.ts"] })).toBe("skip");
});

test("a TypeScript path with a safe-rule finding runs the fixers", () => {
  expect(decide({ lintClean: false, lintPaths: ["./source.ts"] })).toBe("run");
});

test("a selected generator runs the fixers", () => {
  expect(decide({ generatorSelected: true })).toBe("run");
});

test("a tool error fails closed and runs the fixers", () => {
  expect(decide({ toolError: "format" })).toBe("run");
  expect(decide({ lintPaths: ["./source.ts"], toolError: "lint" })).toBe("run");
});

import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { integrityMatches, readAutofixOxlint } from "./autofix-oxlint";
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
    {
      generatorSelected,
      toolReady: true,
      formatPaths: ["./README.md"],
      lintPaths,
    },
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

test("an unavailable integrity-verified linter runs the full job", () => {
  expect(
    decideAutofixPreflight(
      {
        generatorSelected: false,
        toolReady: false,
        formatPaths: [],
        lintPaths: [],
      },
      { formatClean: () => true, lintClean: () => true },
    ),
  ).toBe("run");
});

test("a tool error fails closed and runs the fixers", () => {
  expect(decide({ toolError: "format" })).toBe("run");
  expect(decide({ lintPaths: ["./source.ts"], toolError: "lint" })).toBe("run");
});

test("the CLI emits only its GitHub output decision when a child writes stdout", () => {
  const root = mkdtempSync(path.join(tmpdir(), "autofix-preflight-"));
  const formatPaths = path.join(root, "format-paths");
  const lintPaths = path.join(root, "lint-paths");
  const fakeBun = path.join(root, "bun");
  writeFileSync(formatPaths, "./README.md\0");
  writeFileSync(lintPaths, "");
  writeFileSync(fakeBun, "#!/bin/sh\necho child-output\nexit 0\n");
  chmodSync(fakeBun, 0o755);

  const result = Bun.spawnSync(
    [
      process.execPath,
      path.join(import.meta.dir, "autofix-preflight.ts"),
      formatPaths,
      lintPaths,
    ],
    { env: { ...process.env, PATH: `${root}:${process.env["PATH"] ?? ""}` } },
  );
  expect(result.exitCode).toBe(0);
  expect(result.stdout.toString()).toBe("run=false\n");
});

const lockFixture = (version = "1.2.3", bindingVersion = version) =>
  JSON.stringify({
    packages: {
      oxlint: [`oxlint@${version}`, "", {}, "sha512-b3hsaW50"],
      "@oxlint/binding-linux-x64-gnu": [
        `@oxlint/binding-linux-x64-gnu@${bindingVersion}`,
        "",
        {},
        "sha512-YmluZGluZw==",
      ],
    },
  });

test("the preflight oxlint version comes from the root lockfile entry", () => {
  expect(readAutofixOxlint(lockFixture()).oxlint.version).toBe("1.2.3");
  expect(() => readAutofixOxlint(lockFixture("1.2.3", "9.9.9"))).toThrow(
    "oxlint and its Linux binding versions differ",
  );
});

test("tarball integrity mismatches fail verification", () => {
  const contents = new TextEncoder().encode("locked archive");
  const integrity = `sha512-${new Bun.CryptoHasher("sha512").update(contents).digest("base64")}`;
  expect(integrityMatches(contents, integrity)).toBe(true);
  expect(integrityMatches(new TextEncoder().encode("mutated"), integrity)).toBe(
    false,
  );
});

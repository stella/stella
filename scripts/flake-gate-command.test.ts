import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import * as v from "valibot";

import { parseBunTestScript } from "./flake-gate-command";

const root = path.resolve(import.meta.dir, "..");
const packageManifestSchema = v.object({
  scripts: v.optional(v.record(v.string(), v.string()), {}),
  ciGateTestRunners: v.optional(v.record(v.string(), v.unknown()), {}),
});

test("preserves quoted Bun test flags and values while dropping positional selectors", () => {
  expect(
    parseBunTestScript(
      `bun test --preload "setup fixtures.ts" --timeout 9000 -t 'GET /cases' src/old.test.ts`,
    ),
  ).toEqual({
    type: "supported",
    flags: [
      "--preload",
      "setup fixtures.ts",
      "--timeout",
      "9000",
      "-t",
      "GET /cases",
    ],
  });
});

test("the test-runner -- terminator drops every following token", () => {
  expect(
    parseBunTestScript(
      "bun test --preload setup.ts src/old.test.ts -- --unknown value",
    ),
  ).toEqual({
    type: "supported",
    flags: ["--preload", "setup.ts"],
  });
});

test("rejects unsafe and ambiguous Bun test commands with typed reasons", () => {
  const unsupported = (script: string) => {
    const result = parseBunTestScript(script);
    if (result.type !== "unsupported") {
      throw new TypeError(`Expected unsupported command: ${script}`);
    }
    return result.reason;
  };

  expect(unsupported("bun test 'unterminated")).toBe("invalid-shell-quoting");
  expect(unsupported('bun test "$TEST_FILE"')).toBe("shell-expansion");
  expect(unsupported("bun test src/a.test.ts && echo done")).toBe(
    "shell-syntax",
  );
  expect(unsupported("sh -c 'bun test src/a.test.ts'")).toBe(
    "not-plain-bun-test",
  );
  expect(unsupported("bun test --unknown-flag")).toBe("unknown-flag");
  expect(unsupported("bun test --preload")).toBe("missing-flag-value");
  expect(unsupported("bun test --cwd apps/api")).toBe("runner-controlled-flag");
});

test("the generic parser records unsupported shell shapes independently of dedicated API and web runners", () => {
  const manifests = [
    ...new Bun.Glob("apps/*/package.json").scanSync({ cwd: root }),
    ...new Bun.Glob("packages/*/package.json").scanSync({ cwd: root }),
  ].toSorted();
  const unsupported = manifests.flatMap((file) => {
    const manifest = v.parse(
      packageManifestSchema,
      JSON.parse(readFileSync(path.join(root, file), "utf-8")),
    );
    return Object.entries(manifest.scripts)
      .filter(
        ([name]) =>
          name === "test" ||
          name === "test:bun" ||
          (name === "test:postgres" &&
            Object.hasOwn(manifest.ciGateTestRunners, name)),
      )
      .flatMap(([name, command]) => {
        const result = parseBunTestScript(command);
        return result.type === "unsupported"
          ? [{ script: `${file}:${name}`, command, reason: result.reason }]
          : [];
      });
  });

  expect(unsupported).toMatchInlineSnapshot(`
    [
      {
        "command": "bun --cwd=../../packages/cli run codegen:runtime || exit 1; bun run generate:capability-runtime || exit 1; bun scripts/run-tests.ts",
        "reason": "shell-syntax",
        "script": "apps/api/package.json:test",
      },
      {
        "command": "bun scripts/run-postgres-tests.ts",
        "reason": "not-plain-bun-test",
        "script": "apps/api/package.json:test:postgres",
      },
      {
        "command": "bun run test:unit",
        "reason": "not-plain-bun-test",
        "script": "apps/extension/package.json:test",
      },
      {
        "command": "bun scripts/precompute-anonymize-demo-sample.ts --check && bun scripts/check-meta-budgets.ts && bun scripts/check-img-alt.ts && bun test src scripts",
        "reason": "shell-syntax",
        "script": "apps/landing/package.json:test",
      },
      {
        "command": "([ -n "$TURBO_HASH" ] || bun run generate:web-sources) || exit 1; bun scripts/run-tests.ts",
        "reason": "shell-expansion",
        "script": "apps/web/package.json:test",
      },
      {
        "command": "bun scripts/generate-manifest.ts --check || exit 1; bun scripts/validate.ts || exit 1; bun test src",
        "reason": "shell-syntax",
        "script": "packages/catalogue/package.json:test",
      },
      {
        "command": "bun run codegen:runtime || exit 1; bun test",
        "reason": "shell-syntax",
        "script": "packages/cli/package.json:test",
      },
      {
        "command": "bun ../../scripts/prepare-mcp-apps.ts && bun test",
        "reason": "shell-syntax",
        "script": "packages/mcp-apps/package.json:test",
      },
      {
        "command": "bun run test:bun && cargo test",
        "reason": "shell-syntax",
        "script": "packages/scan-engine/package.json:test",
      },
      {
        "command": "bun scripts/generate-manifests.ts --check || exit 1; bun test src",
        "reason": "shell-syntax",
        "script": "packages/skills/package.json:test",
      },
      {
        "command": "bun scripts/generate-manifest.ts --check || exit 1; bun scripts/generate-manifest.ts --check --fixtures || exit 1; bun test src",
        "reason": "shell-syntax",
        "script": "packages/template-packs/package.json:test",
      },
      {
        "command": "bun run test:unit",
        "reason": "not-plain-bun-test",
        "script": "packages/ui/package.json:test",
      },
    ]
  `);
});

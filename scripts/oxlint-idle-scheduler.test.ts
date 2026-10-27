import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as v from "valibot";

import config from "../oxlint.config.ts";
import { readScopes } from "./oxlint-config-scopes.ts";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const diagnosticReport = v.object({
  diagnostics: v.array(
    v.object({
      code: v.string(),
      message: v.string(),
      help: v.optional(v.string()),
    }),
  ),
});

// Preserve real override order in a temporary repository-shaped tree so the
// public SSR restrictions cannot silently replace the scheduler restriction.
const lintIdleCalls = async (relativePath: string, source: string) => {
  const directory = await mkdtemp(path.join(tmpdir(), "stella-idle-lint-"));
  try {
    const input = path.join(directory, relativePath);
    const configPath = path.join(directory, "oxlint.config.ts");
    const overrides = readScopes(config).map(
      ({ files, excludeFiles, rules }) => ({
        files,
        excludeFiles,
        rules: Object.fromEntries(
          Object.entries(rules).filter(([rule]) =>
            ["no-restricted-globals", "no-restricted-properties"].includes(
              rule,
            ),
          ),
        ),
      }),
    );
    await Bun.write(input, source);
    await Bun.write(
      configPath,
      `export default ${JSON.stringify({
        env: { browser: true },
        categories: { correctness: "off" },
        overrides,
      })};`,
    );
    const process = Bun.spawn(
      ["bun", "--bun", "oxlint", "-c", configPath, "--format", "json", input],
      { cwd: repositoryRoot, stderr: "pipe", stdout: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect([0, 1]).toContain(exitCode);
    expect(stderr).not.toContain("Failed to load");
    return v.parse(diagnosticReport, JSON.parse(stdout)).diagnostics;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};

test.each([
  "requestIdleCallback(work);",
  "cancelIdleCallback(handle);",
  "window.requestIdleCallback(work);",
  "globalThis.cancelIdleCallback(handle);",
  "browser.requestIdleCallback(work);",
  'browser["cancelIdleCallback"](handle);',
  "const { requestIdleCallback: idle } = browser; idle(work);",
])(
  "web code routes idle APIs through the shared scheduler: %s",
  async (source) => {
    const findings = await lintIdleCalls("apps/web/src/lib/probe.ts", source);
    expect(findings.length).toBeGreaterThan(0);
    expect(
      findings.every(({ message, help }) =>
        `${message} ${help ?? ""}`.includes("scheduleIdle"),
      ),
    ).toBe(true);
  },
);

test("the scheduler owns the native idle APIs", async () => {
  expect(
    await lintIdleCalls(
      "apps/web/src/lib/schedule-idle.ts",
      "window.requestIdleCallback(work); window.cancelIdleCallback(handle);",
    ),
  ).toEqual([]);
});

test("public SSR keeps both its ambient-state and idle scheduler guards", async () => {
  const findings = await lintIdleCalls(
    "apps/web/src/features/case-law/probe.ts",
    "Date.now(); browser.requestIdleCallback(work);",
  );
  expect(
    findings.some(({ message, help }) =>
      `${message} ${help ?? ""}`.includes("hydration-safe"),
    ),
  ).toBe(true);
  expect(
    findings.some(({ message, help }) =>
      `${message} ${help ?? ""}`.includes("scheduleIdle"),
    ),
  ).toBe(true);
});

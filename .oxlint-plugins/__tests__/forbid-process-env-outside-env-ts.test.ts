import { expect, test } from "bun:test";

import { lintSingleRule } from "./lint-single-rule.ts";

test("reports server environment spellings", async () => {
  expect(
    await lintSingleRule(
      "forbid-process-env-outside-env-ts",
      'process.env.VALUE;\nprocess["env"]["VALUE"];\nBun.env.VALUE;\nimport.meta.env.VALUE;',
      { sourcePath: "apps/api/src/worker.ts", cwd: "scratch" },
    ),
  ).toEqual([1, 2, 3, 4]);
});

test("follows imported and destructured environment bindings", async () => {
  expect(
    await lintSingleRule(
      "forbid-process-env-outside-env-ts",
      'import { env as settings } from "node:process";\nsettings.VALUE;\nconst { env: values } = process;\nvalues.VALUE;',
      { sourcePath: "apps/api/src/worker.ts", cwd: "scratch" },
    ),
  ).toEqual([1, 3]);
});

test("allows approved env boundaries", async () => {
  expect(
    await lintSingleRule(
      "forbid-process-env-outside-env-ts",
      "process.env.VALUE;",
      { sourcePath: "apps/api/src/env.ts", cwd: "scratch" },
    ),
  ).toEqual([]);
});

test("rejects nested scripts directories", async () => {
  expect(
    await lintSingleRule(
      "forbid-process-env-outside-env-ts",
      "process.env.VALUE;",
      { sourcePath: "apps/api/src/scripts/worker.ts", cwd: "scratch" },
    ),
  ).toEqual([1]);
});

test("allows Vite client metadata and local process shadows", async () => {
  expect(
    await lintSingleRule(
      "forbid-process-env-outside-env-ts",
      "function local(process, Bun) { return [process.env.VALUE, Bun.env.VALUE]; }\nimport.meta.env.VALUE;",
      { sourcePath: "apps/web/src/example.ts", cwd: "scratch" },
    ),
  ).toEqual([]);
});

test("supports explicitly approved directory boundaries", async () => {
  expect(
    await lintSingleRule(
      "forbid-process-env-outside-env-ts",
      "process.env.VALUE;",
      {
        sourcePath: "apps/api/src/config/worker.ts",
        cwd: "scratch",
        ruleOptions: { allowedDirectories: ["apps/api/src/config/"] },
      },
    ),
  ).toEqual([]);
});

test("does not broaden an approved directory to a prefix sibling", async () => {
  expect(
    await lintSingleRule(
      "forbid-process-env-outside-env-ts",
      "process.env.VALUE;",
      {
        sourcePath: "apps/api/src/configuration/worker.ts",
        cwd: "scratch",
        ruleOptions: { allowedDirectories: ["apps/api/src/config/"] },
      },
    ),
  ).toEqual([1]);
});

test("allows a workspace tooling script", async () => {
  expect(
    await lintSingleRule(
      "forbid-process-env-outside-env-ts",
      "process.env.VALUE;",
      { sourcePath: "apps/api/scripts/tool.ts", cwd: "scratch" },
    ),
  ).toEqual([]);
});

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  routeSmokeAffected,
  routeSmokeImportClosure,
} from "./detect-route-smoke-changes";

const writeFixture = (root: string, file: string, source: string): void => {
  const absolute = path.join(root, file);
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, source);
};

describe("route traffic changes require the route smoke", () => {
  test.each([
    "apps/web/src/routes/_authenticated/new-route.tsx",
    "apps/web/src/routeTree.gen.ts",
    "apps/web/src/hooks/use-query.ts",
    "apps/web/src/components/new-component.tsx",
    "apps/web/public/service-worker.js",
    "apps/web/scripts/runtime-asset-contracts.ts",
    "apps/web/vite.config.ts",
    "apps/web/.env.example",
    "apps/web/e2e/network-baseline.json",
    "scripts/network-baseline-scope.ts",
    "scripts/network-baseline-scope.test.ts",
    "scripts/network-baseline-comparison.test.ts",
    "apps/web/e2e/network-budgets/feature.json",
    ".github/actions/prepare-network-baseline/action.yml",
    ".github/actions/prepare-network-baseline/prepare.sh",
    "apps/api/src/routes/contacts.ts",
    "apps/api/scripts/seed-test-user.ts",
    "packages/ui/src/new-component.tsx",
    "packages/api-contract/src/schema.ts",
    ".github/actions/setup-e2e-stack/action.yml",
    ".github/actions/setup-production-e2e/action.yml",
    ".github/actions/setup-playwright/action.yml",
    ".github/actions/build-e2e-web/action.yml",
    ".github/workflows/ci.yml",
    "scripts/detect-route-smoke-changes.ts",
    "scripts/detect-route-smoke-changes.test.ts",
    "bun.lock",
    "bunfig.toml",
    "package.json",
    ".npmrc",
    "turbo.json",
    "docker-compose.yml",
    "docker/postgres/init.sql",
    "scripts/retry.sh",
    "patches/dependency.patch",
    "apps/web/e2e/fixtures/simple.docx",
  ])("plans a smoke for %s", (file) => {
    expect(routeSmokeAffected([file])).toBe(true);
  });

  test("binds real spec, config and transitive helper imports to the filter", () => {
    const closure = routeSmokeImportClosure();
    expect(closure.has("apps/web/e2e/specs/route-smoke.spec.ts")).toBe(true);
    expect(closure.has("apps/web/e2e/playwright.config.ts")).toBe(true);
    expect(closure.has("apps/web/e2e/helpers/network.ts")).toBe(true);
    expect(closure.has("apps/web/e2e/helpers/api.ts")).toBe(true);
    expect(closure.has("apps/web/e2e/execution-profile.ts")).toBe(true);
    expect(closure.has("apps/web/e2e/global-teardown.ts")).toBe(true);
    for (const file of closure) {
      expect(routeSmokeAffected([file])).toBe(true);
    }
  });

  test.each([
    "docs/development.md",
    "apps/landing/src/routes/index.tsx",
    "apps/web/e2e/specs/unrelated.spec.ts",
    "apps/web/e2e/marketing/landing.spec.ts",
    "scripts/unrelated.ts",
  ])("does not plan a smoke for %s", (file) => {
    expect(routeSmokeAffected([file])).toBe(false);
  });

  test("empty changes do not plan a smoke", () => {
    expect(routeSmokeAffected([])).toBe(false);
  });

  test("new transitive imports are picked up, including deleted helpers and cycles", () => {
    const root = mkdtempSync(path.join(tmpdir(), "route-smoke-scope-"));
    try {
      writeFixture(
        root,
        "apps/web/e2e/specs/route-smoke.spec.ts",
        'import { helper } from "../../../../tools/helper"; helper();',
      );
      writeFixture(root, "tools/helper.ts", "export const helper = () => {};");
      const newlyImported = "tools/deep/new-helper.ts";
      expect(routeSmokeAffected([newlyImported], root)).toBe(false);
      writeFixture(
        root,
        "tools/helper.ts",
        'export { helper } from "./deep/new-helper.js";',
      );
      writeFixture(
        root,
        newlyImported,
        'import "../helper"; export const helper = () => import("./deleted");',
      );
      expect(routeSmokeAffected([newlyImported], root)).toBe(true);
      expect(routeSmokeAffected(["tools/deep/deleted.ts"], root)).toBe(true);
      rmSync(path.join(root, newlyImported));
      expect(routeSmokeAffected([newlyImported], root)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("parses each helper with its own grammar", () => {
    const root = mkdtempSync(path.join(tmpdir(), "route-smoke-grammar-"));
    try {
      writeFixture(
        root,
        "apps/web/e2e/specs/route-smoke.spec.ts",
        'import { request } from "../helpers/api";',
      );
      // Valid TypeScript that the TSX grammar rejects.
      writeFixture(
        root,
        "apps/web/e2e/helpers/api.ts",
        'import "./next";\nexport const request = async <T>(value: T) => <T>value;',
      );
      writeFixture(
        root,
        "apps/web/e2e/helpers/next.tsx",
        "export const view = <div />;",
      );
      expect(routeSmokeAffected(["docs/development.md"], root)).toBe(false);
      expect(routeSmokeAffected(["apps/web/e2e/helpers/next.tsx"], root)).toBe(
        true,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("CLI prints only the boolean scope decision", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["apps/web/src/routes/new.tsx", "true\n"],
      ["docs/development.md", "false\n"],
    ];
    for (const [file, expected] of cases) {
      const result = Bun.spawnSync([
        process.execPath,
        path.join(import.meta.dirname, "detect-route-smoke-changes.ts"),
        file,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.toString()).toBe(expected);
    }
  });
});

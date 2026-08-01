import { describe, expect, test } from "bun:test";
import path from "node:path";

const script = path.join(import.meta.dirname, "detect-e2e-changes.sh");

const detects = (scope: "core" | "landing" | "marketing", files: string[]) =>
  Bun.spawnSync(["bash", script, scope, ...files], {
    stdout: "pipe",
  })
    .stdout.toString()
    .trim();

describe("detect-e2e-changes", () => {
  test("skips documentation-only changes", () => {
    expect(detects("core", ["README.md"])).toBe("false");
    expect(detects("marketing", ["README.md"])).toBe("false");
    expect(detects("landing", ["README.md"])).toBe("false");
  });

  test("runs product-code changes through core and marketing", () => {
    const files = ["apps/api/src/handlers/tasks/get.ts"];
    expect(detects("core", files)).toBe("true");
    expect(detects("marketing", files)).toBe("true");
    expect(detects("landing", files)).toBe("false");
  });

  test("covers the complete screenshot runtime dependency surface", () => {
    for (const file of [
      "apps/api/src/handlers/case-law/decisions/get.ts",
      "apps/api/scripts/seed-case-law.ts",
      "apps/api/scripts/seed-utils.ts",
      "apps/api/scripts/__fixtures__/case-law/cz-us.json",
      "apps/web/src/app-providers.tsx",
      "packages/workspace-ui/src/workspace.tsx",
    ]) {
      expect(detects("core", [file])).toBe("true");
      expect(detects("marketing", [file])).toBe("true");
      expect(detects("landing", [file])).toBe("false");
    }
  });

  test("test-only product files do not trigger marketing screenshots", () => {
    for (const file of [
      "apps/api/scripts/seed-dev.test.ts",
      "apps/api/scripts/__fixtures__/case-law/eu-ecj.test.ts",
      "apps/api/src/handlers/tasks/get.test.ts",
      "apps/web/src/features/tasks/task-list.spec.tsx",
    ]) {
      expect(detects("core", [file])).toBe("true");
      expect(detects("marketing", [file])).toBe("false");
      expect(detects("landing", [file])).toBe("false");
    }
  });

  test("a marketing-test-only change skips the broad app suite", () => {
    const files = ["apps/web/e2e/marketing/product-screenshots.spec.ts"];
    expect(detects("core", files)).toBe("false");
    expect(detects("marketing", files)).toBe("true");
    expect(detects("landing", files)).toBe("false");
  });

  test("keeps a landing-only change out of app E2E", () => {
    for (const file of [
      "apps/landing/src/pages/index.astro",
      "apps/web/e2e/marketing/landing-navigation.spec.ts",
    ]) {
      expect(detects("core", [file])).toBe("false");
      expect(detects("marketing", [file])).toBe("false");
      expect(detects("landing", [file])).toBe("true");
    }
  });

  test("the shared marketing config exercises both projects", () => {
    const files = ["apps/web/e2e/playwright.marketing.config.ts"];
    expect(detects("core", files)).toBe("false");
    expect(detects("marketing", files)).toBe("true");
    expect(detects("landing", files)).toBe("true");
  });

  test("runs every scope when its orchestration changes", () => {
    const files = [".github/workflows/ci.yml"];
    expect(detects("core", files)).toBe("true");
    expect(detects("marketing", files)).toBe("true");
    expect(detects("landing", files)).toBe("true");
  });
});

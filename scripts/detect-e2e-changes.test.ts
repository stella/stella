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

  test("keeps an ordinary API change out of marketing and landing", () => {
    const files = ["apps/api/src/handlers/tasks/get.ts"];
    expect(detects("core", files)).toBe("true");
    expect(detects("marketing", files)).toBe("false");
    expect(detects("landing", files)).toBe("false");
  });

  test("runs marketing only for declared screenshot inputs", () => {
    for (const file of [
      "apps/web/src/routes/_protected.chat/index.tsx",
      "apps/web/src/features/case-law/components/case-viewer.tsx",
      "apps/web/src/i18n/langs/fr.json",
    ]) {
      expect(detects("core", [file])).toBe("true");
      expect(detects("marketing", [file])).toBe("true");
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
    const files = ["apps/landing/src/pages/index.astro"];
    expect(detects("core", files)).toBe("false");
    expect(detects("marketing", files)).toBe("false");
    expect(detects("landing", files)).toBe("true");
  });

  test("runs every scope when its orchestration changes", () => {
    const files = [".github/workflows/ci.yml"];
    expect(detects("core", files)).toBe("true");
    expect(detects("marketing", files)).toBe("true");
    expect(detects("landing", files)).toBe("true");
  });
});

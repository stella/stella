import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

describe("journey-canary workflow publish package imports", () => {
  test("imports the published-version check from exactly its sparse checkout without node_modules", async () => {
    const workflow = await Bun.file(
      path.join(REPO_ROOT, ".github/workflows/journey-canary.yml"),
    ).text();
    const sparseCheckout = workflow
      .split("          sparse-checkout: |\n")
      .at(1)
      ?.split("          sparse-checkout-cone-mode:")
      .at(0);
    expect(sparseCheckout).toBeDefined();
    const files = (sparseCheckout ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.startsWith("/"));
    expect(files).toContain("/scripts/publish-packages.ts");
    expect(files).not.toContain("/scripts/changeset-policy.json");

    const directory = await mkdtemp(path.join(tmpdir(), "journey-canary-"));
    try {
      for (const file of files) {
        const relative = file.slice(1);
        await mkdir(path.dirname(path.join(directory, relative)), {
          recursive: true,
        });
        await cp(
          path.join(REPO_ROOT, relative),
          path.join(directory, relative),
        );
      }
      const result = Bun.spawnSync(
        [
          process.execPath,
          "-e",
          'await import("./scripts/check-published-versions.ts")',
        ],
        { cwd: directory, env: { PATH: process.env["PATH"] } },
      );
      expect(new TextDecoder().decode(result.stderr)).toBe("");
      expect(result.exitCode).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

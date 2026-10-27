import { describe, expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { ALL_PACKAGE_ORDER } from "./publish-packages";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

describe("publish-npm verify-npm workflow publish package imports", () => {
  test("loads the lag check and computes dependency order without node_modules", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "verify-npm-"));
    try {
      for (const relative of [
        "scripts/check-npm-publish-lag.ts",
        "scripts/promoted-release-policy.ts",
        "scripts/publish-packages.ts",
        "scripts/changeset-policy.json",
      ]) {
        await mkdir(path.dirname(path.join(directory, relative)), {
          recursive: true,
        });
        await cp(
          path.join(REPO_ROOT, relative),
          path.join(directory, relative),
        );
      }
      for (const packageName of ALL_PACKAGE_ORDER) {
        const relative = `packages/${packageName}/package.json`;
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
          'const lag = await import("./scripts/check-npm-publish-lag.ts"); const { ALL_PACKAGE_ORDER, dependenciesFirst } = await import("./scripts/publish-packages.ts"); if (dependenciesFirst(ALL_PACKAGE_ORDER).join(",") !== ALL_PACKAGE_ORDER.join(",") || typeof lag.readPublishablePackages !== "function") process.exit(1)',
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

// Builds the production artifact once, so the custom bundler, the Tailwind
// step, the manifest render and its XSD validation run wherever the package
// tests run, not only when someone releases.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  getHtmlAssetPaths,
  getHtmlReleaseVersion,
  isContentHashedCodeAsset,
} from "./release-artifact";

const APP_ROOT = path.resolve(import.meta.dirname, "..");
const BUILD_TIMEOUT_MS = 120_000;
const HTML_FILES = [
  "taskpane.html",
  "commands.html",
  "auth/start.html",
  "auth/callback.html",
] as const;

let outDir = "";

const read = (file: string): string =>
  readFileSync(path.join(outDir, file), "utf-8");

// timeout: one full bundle and Tailwind build runs before the assertions.
beforeAll(() => {
  outDir = mkdtempSync(path.join(tmpdir(), "stella-outlook-build-"));
  const build = Bun.spawnSync(
    ["bun", "scripts/build.ts", "--env=prod", `--out-dir=${outDir}`],
    {
      cwd: APP_ROOT,
      env: { ...process.env, STELLA_OUTLOOK_VERSION: "1.2.3.4" },
    },
  );
  expect(build.exitCode, new TextDecoder().decode(build.stderr)).toBe(0);
}, BUILD_TIMEOUT_MS);

afterAll(() => {
  rmSync(outDir, { force: true, recursive: true });
});

describe("production build", () => {
  test("stamps one version on every document and hashed asset", () => {
    for (const file of HTML_FILES) {
      const html = read(file);
      expect(getHtmlReleaseVersion(html)).toBe("1.2.3.4");
      expect(html).toContain('content="noindex, nofollow"');
      const assets = getHtmlAssetPaths(html);
      expect(assets.length).toBeGreaterThan(0);
      expect(assets.every(isContentHashedCodeAsset)).toBe(true);
    }
    expect(read("manifest.xml")).toContain("<Version>1.2.3.4</Version>");
  });

  test("builds against the production origins", () => {
    const release: unknown = JSON.parse(read("release.json"));
    expect(release).toMatchObject({
      origins: {
        apiOrigin: "https://api.stll.app",
        taskpaneOrigin: "https://outlook.stll.app",
        webOrigin: "https://my.stll.app",
      },
      version: "1.2.3.4",
    });
    const bundles = readdirSync(path.join(outDir, "assets"))
      .filter((file) => file.endsWith(".js"))
      .map((file) => read(path.join("assets", file)));
    expect(bundles.some((code) => code.includes("https://api.stll.app"))).toBe(
      true,
    );
  });

  test("declares headers for the sign-in pages", () => {
    const headers: unknown = JSON.parse(read("deployment-headers.json"));
    expect(headers).toMatchObject({
      rules: expect.arrayContaining([
        expect.objectContaining({ path: "/auth/start.html" }),
        expect.objectContaining({ path: "/auth/callback.html" }),
      ]),
    });
  });
});

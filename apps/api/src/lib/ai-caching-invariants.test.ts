import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * TanStack AI boundary enforcement: live app code must not reintroduce
 * legacy provider SDK imports, and provider adapter construction stays centralized
 * in tanstack-ai-models.ts so caching, service tiers, BYOK routing, and
 * unsupported-provider failures cannot drift by call site.
 */
describe("TanStack AI is the only live app provider SDK boundary", () => {
  test("app source has no direct legacy provider SDK imports", async () => {
    const repoRoot = path.resolve(import.meta.dir, "../../../..");
    const glob = new Glob("apps/{api,web}/{src,scripts}/**/*.{ts,tsx}");
    const forbiddenImport =
      /\bfrom\s+["'](?:@ai-sdk\/[^"']+|ai|ai\/[^"']+|@openrouter\/ai-sdk-provider)["']/u;
    const offenders: string[] = [];

    for await (const relative of glob.scan({
      cwd: repoRoot,
      onlyFiles: true,
    })) {
      const contents = await readFile(
        path.resolve(repoRoot, relative),
        "utf-8",
      );
      if (forbiddenImport.test(contents)) {
        offenders.push(relative);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("TanStack provider adapter factories stay at explicit boundaries", async () => {
    const apiSrc = path.resolve(import.meta.dir, "..");
    const glob = new Glob("**/*.ts");
    const allowed = new Set([
      "lib/tanstack-ai-models.ts",
      // These contract tests deliberately construct real adapters with intercepted
      // clients; they are not imported by app code.
      "handlers/chat/tools/provider-null-normalization.property.test.ts",
      "handlers/chat/tools/tool-schema.test.ts",
    ]);
    const forbiddenPackages = [
      "@tanstack/ai-anthropic",
      "@tanstack/ai-gemini",
      "@tanstack/ai-openai",
      "@tanstack/ai-openrouter",
    ];
    const providerValueImport = new RegExp(
      `\\bimport\\s+(?!type\\b)[^;]*\\bfrom\\s+["'](?:${forbiddenPackages
        .map((name) => name.replaceAll("/", "\\/"))
        .join("|")})["']`,
      "u",
    );
    const offenders: string[] = [];

    for await (const relative of glob.scan({ cwd: apiSrc, onlyFiles: true })) {
      if (allowed.has(relative)) {
        continue;
      }

      const contents = await readFile(path.resolve(apiSrc, relative), "utf-8");
      if (providerValueImport.test(contents)) {
        offenders.push(relative);
      }
    }

    expect(offenders).toEqual([]);
  });
});

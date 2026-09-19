import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * TanStack AI boundary enforcement: provider adapter construction stays
 * centralized in tanstack-ai-models.ts so caching, service tiers, BYOK routing,
 * and unsupported-provider failures cannot drift by call site.
 *
 * The cross-app half — no app source imports a legacy provider SDK — reads
 * apps/web as well, so it lives in
 * packages/scripts/src/app-provider-sdk-boundary.test.ts, whose package
 * declares the whole tree as a test input.
 */
describe("TanStack AI is the only live app provider SDK boundary", () => {
  test("TanStack provider adapter factories stay at explicit boundaries", async () => {
    const apiSrc = path.resolve(import.meta.dir, "..");
    const glob = new Glob("**/*.ts");
    const allowed = new Set([
      "lib/tanstack-ai-models.ts",
      // Stella's document-transport override subclasses the stable OpenRouter
      // adapter; model construction remains centralized in tanstack-ai-models.
      "lib/stella-openrouter-text-adapter.ts",
      // These contract tests deliberately construct real adapters with intercepted
      // clients; they are not imported by app code.
      "handlers/chat/stream-chat.test.ts",
      "handlers/chat/chat-schema.seam.test.ts",
      "handlers/chat/tools/provider-null-normalization.property.test.ts",
      "handlers/chat/tools/tool-schema.test.ts",
      "lib/provider-document-adapters.test.ts",
      "lib/provider-heic-adapter.test.ts",
      "lib/tanstack-ai-generate.canary.test.ts",
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

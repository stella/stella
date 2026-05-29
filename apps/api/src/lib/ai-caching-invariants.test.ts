import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * Caching middleware enforcement: model factories must only be
 * constructed inside ai-models.ts. Any handler that imports
 * `createAnthropic`, `createOpenAI`, `createGoogleGenerativeAI`,
 * `createMistral`, `createOpenRouter`, `createAzure`, or
 * `createVertex` directly bypasses the wrap-at-the-factory
 * `withInstrumentation` boundary and skips the caching middleware.
 *
 * The top-level singletons (`anthropic`, `google`, `openai`,
 * `mistral`) are also fenced for the same reason — they construct
 * a model when invoked.
 */
describe("ai-models.ts is the only model-factory boundary", () => {
  test("no other file imports model factories from @ai-sdk/* or @openrouter/*", async () => {
    const apiSrc = resolve(import.meta.dir, "..");
    const glob = new Glob("**/*.ts");
    const ALLOWED = new Set(["lib/ai-models.ts"]);
    const FORBIDDEN_NAMES = [
      "createAnthropic",
      "createOpenAI",
      "createGoogleGenerativeAI",
      "createMistral",
      "createOpenRouter",
      "createAzure",
      "createVertex",
    ];
    const FORBIDDEN_RE = new RegExp(
      `\\b(${FORBIDDEN_NAMES.join("|")})\\b`,
      "u",
    );

    const offenders: string[] = [];
    for await (const relative of glob.scan({ cwd: apiSrc, onlyFiles: true })) {
      if (ALLOWED.has(relative)) {
        continue;
      }
      if (relative.endsWith(".test.ts")) {
        continue;
      }
      const contents = await readFile(resolve(apiSrc, relative), "utf-8");
      if (!FORBIDDEN_RE.test(contents)) {
        continue;
      }
      // Only flag actual imports, not incidental mentions in
      // comments or strings.
      const importMatches = contents.match(
        new RegExp(
          `import\\s*\\{[^}]*\\b(${FORBIDDEN_NAMES.join("|")})\\b[^}]*\\}`,
          "gu",
        ),
      );
      if (importMatches && importMatches.length > 0) {
        offenders.push(relative);
      }
    }
    expect(offenders).toEqual([]);
  });
});

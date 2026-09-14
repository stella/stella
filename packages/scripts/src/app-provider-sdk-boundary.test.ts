import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * TanStack AI boundary enforcement: live app code must not reintroduce legacy
 * provider SDK imports.
 *
 * The guard reads source from both apps, so it lives in the package whose test
 * inputs declare the whole tree (`$TURBO_ROOT$/apps/**` on `@stll/scripts#test`)
 * rather than inside one app, where Turbo would run it only when that app
 * changed. The api-internal half of the boundary — which modules may construct
 * a provider adapter — stays in apps/api/src/lib/ai-caching-invariants.test.ts.
 */
describe("TanStack AI is the only live app provider SDK boundary", () => {
  test("app source has no direct legacy provider SDK imports", async () => {
    const repoRoot = path.resolve(import.meta.dir, "../../..");
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
});

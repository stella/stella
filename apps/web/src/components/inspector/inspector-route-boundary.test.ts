import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

const SHARED_INSPECTOR_MODULE_DIRS = [
  "components/inspector",
  "features/chat",
] as const;
const SOURCE_MODULE_GLOB = "**/*.{ts,tsx}";
const PROTECTED_ROUTE_DEPENDENCY =
  /(?:@\/routes\/_protected|getRouteApi\(\s*["']\/_protected["'])/u;

describe("shared inspector route boundary", () => {
  test("does not depend on protected route context", async () => {
    const sourceRoot = nodePath.resolve(import.meta.dir, "../..");
    const glob = new Bun.Glob(SOURCE_MODULE_GLOB);
    const scannedPaths = (
      await Promise.all(
        SHARED_INSPECTOR_MODULE_DIRS.map(async (moduleDir) => {
          const modulePaths: string[] = [];
          for await (const relativePath of glob.scan({
            cwd: nodePath.resolve(sourceRoot, moduleDir),
          })) {
            if (!relativePath.includes(".test.")) {
              modulePaths.push(nodePath.join(moduleDir, relativePath));
            }
          }
          return modulePaths;
        }),
      )
    ).flat();

    expect(scannedPaths).toContain(
      "features/chat/hooks/use-rename-chat-thread.ts",
    );
    const matches = await Promise.all(
      scannedPaths.map(async (sourcePath) => ({
        sourcePath,
        violates: PROTECTED_ROUTE_DEPENDENCY.test(
          await Bun.file(nodePath.resolve(sourceRoot, sourcePath)).text(),
        ),
      })),
    );
    const violations = matches
      .filter(({ violates }) => violates)
      .map(({ sourcePath }) => sourcePath);
    expect(violations).toEqual([]);
  });
});

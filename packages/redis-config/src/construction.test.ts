import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dir, "../../..");
const factories = new Set([
  "apps/api/src/lib/redis-client.ts",
  "apps/collab/src/server.ts",
]);

test("application clients use the configured factories", () => {
  const violations: string[] = [];
  for (const file of new Bun.Glob(
    "{apps,packages}/*/{src,scripts}/**/*.{ts,tsx}",
  ).scanSync({ cwd: root, onlyFiles: true })) {
    if (
      file.includes("/__fixtures__/") ||
      /\.(?:test|spec)\.[cm]?tsx?$/u.test(file) ||
      file.includes("/tests/") ||
      factories.has(file)
    ) {
      continue;
    }
    const source = readFileSync(path.join(root, file), "utf-8");
    const imports = source.matchAll(
      /import\s+([^;]+?)\s+from\s+["'](bun|bullmq|ioredis)["']/gu,
    );
    for (const [, clause, module] of imports) {
      if (clause === undefined) {
        continue;
      }
      const isClient =
        module === "ioredis"
          ? !/^type\s/u.test(clause.trim())
          : /\b(?:RedisClient|redis|createBunRedisClient)\b|\*\s+as\b/u.test(
              clause,
            );
      if (isClient) {
        violations.push(file);
      }
    }
    if (
      /\bBun\.(?:RedisClient|redis)\b|\b(?:require|import)\s*\(\s*["'](?:bullmq|ioredis)["']/u.test(
        source,
      )
    ) {
      violations.push(file);
    }
  }
  expect(violations).toEqual([]);
});

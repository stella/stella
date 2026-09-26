import { describe, expect, test } from "bun:test";
import path from "node:path";

// Every module that writes a skill row or a skill resource must derive the
// stored content hash from the content-hash module; content-hash.db.test.ts
// proves each such path leaves the hash equal to a fresh computation.
const SRC_ROOT = path.join(import.meta.dir, "../..");
const SKILL_CONTENT_WRITE =
  /\.(?:insert|update)\(agentSkills\)|\.(?:insert|update|delete)\(agentSkillResources\)/u;
const CONTENT_HASH_IMPORT =
  /from "(?:@\/api\/lib\/agent-skills\/content-hash|\.\/content-hash)"/u;

const skillContentWriters = async (): Promise<string[]> => {
  const writers: string[] = [];
  for await (const file of new Bun.Glob("**/*.ts").scan(SRC_ROOT)) {
    if (file.endsWith(".test.ts") || file.startsWith("tests/")) {
      continue;
    }
    const source = await Bun.file(path.join(SRC_ROOT, file)).text();
    if (SKILL_CONTENT_WRITE.test(source)) {
      writers.push(file);
    }
  }
  return writers.toSorted();
};

describe("skill content hash writers", () => {
  test("every module that writes skill content imports the content hash owner", async () => {
    const writers = await skillContentWriters();
    const source = async (file: string) =>
      await Bun.file(path.join(SRC_ROOT, file)).text();

    expect(writers).toContain("handlers/skills/update.ts");
    const missing: string[] = [];
    for (const file of writers) {
      if (
        file !== "lib/agent-skills/content-hash.ts" &&
        !CONTENT_HASH_IMPORT.test(await source(file))
      ) {
        missing.push(file);
      }
    }
    expect(missing).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import nodePath from "node:path";

// Every query option that reads the public-law API shares one retry: route
// loaders fetch without retries, so a read without it turns a busy corpus
// (429) into the route's error page. Found by scanning, so a new read cannot
// be left off a hand-kept list.
const SOURCE = nodePath.resolve(import.meta.dir);
const READ = "unwrapPublicLawEden(";
const OPTION = /\b(?:infiniteQueryOptions|queryOptions)\(\{/gu;
const RETRY = /\.\.\.PUBLIC_LAW_READ_RETRY\b/gu;

const publicLawQueryFiles = [
  ...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: SOURCE }),
].filter((file) => {
  if (/\.test\.tsx?$/u.test(file)) {
    return false;
  }
  const source = readFileSync(nodePath.join(SOURCE, file), "utf-8");
  return source.includes(READ) && (source.match(OPTION)?.length ?? 0) > 0;
});

describe("public-law read retry", () => {
  test("the scan finds the public-law query modules", () => {
    expect(publicLawQueryFiles).toContain(
      "features/case-law/queries/decisions.ts",
    );
  });

  test.each(publicLawQueryFiles)(
    "%s gives every query option the shared retry",
    (file) => {
      const source = readFileSync(nodePath.join(SOURCE, file), "utf-8");
      expect(source.match(RETRY)?.length ?? 0).toBe(
        source.match(OPTION)?.length ?? 0,
      );
    },
  );
});

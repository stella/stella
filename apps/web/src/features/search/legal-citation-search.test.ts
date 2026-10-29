import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const sourceRoot = fileURLToPath(new URL("../../", import.meta.url));
const sourceFiles = [
  ...new Bun.Glob("**/*.{ts,tsx}").scanSync(sourceRoot),
].filter((path) => !/\.(?:test|spec)\./u.test(path));

// Navigation and global search may invoke the shared lookups; a third
// citation lookup must extend their owner rather than implement a new probe.
const lookupCallers = {
  readDecisionMatch: [
    "features/case-law/open-decision-match.ts",
    "features/search/legal-citation-search.ts",
  ],
  readStatuteMatch: [
    "features/statutes/open-statute-match.ts",
    "features/search/legal-citation-search.ts",
  ],
} as const;

describe("citation lookup ownership", () => {
  test.each(Object.entries(lookupCallers))(
    "%s has only the legal database and global search callers",
    async (lookup, expected) => {
      const callers: string[] = [];
      const invocation = new RegExp(`\\b${lookup}\\s*\\(`, "u");
      for (const file of sourceFiles) {
        if (invocation.test(await Bun.file(`${sourceRoot}${file}`).text())) {
          callers.push(file);
        }
      }
      expect(callers.toSorted()).toEqual([...expected].toSorted());
    },
  );

  test("global search surfaces delegate citation interpretation to the shared owner", async () => {
    const searchSurfaces = sourceFiles.filter((file) =>
      /^(?:components\/search[^/]*|lib\/search[^/]*)\.[cm]?[jt]sx?$/u.test(
        file,
      ),
    );
    expect(searchSurfaces).toContain("components/search-dialog.tsx");
    const directParsers: string[] = [];
    for (const file of searchSurfaces) {
      const source = await Bun.file(`${sourceRoot}${file}`).text();
      if (
        /\b(?:parseDecisionQuery|parseStatuteQuery|resolveDecisionIdentity|namedDecisionsOf|readDecisionIntent|readStatuteIntent)\b/u.test(
          source,
        )
      ) {
        directParsers.push(file);
      }
    }
    expect(directParsers).toEqual([]);
  });
});

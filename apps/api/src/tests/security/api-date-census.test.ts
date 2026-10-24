import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

const repoRoot = nodePath.resolve(import.meta.dir, "../../../../..");

// Where API schemas are written: the API itself and the contract package
// whose schemas it reads and answers with.
const SCHEMA_ROOTS = ["apps/api/src", "packages/api-contract/src"];
// The owner composes the checks; everything else uses what it exports.
const OWNER = "packages/api-contract/src/api-date.ts";
// Development helpers, one-off scripts and tests never take a request or
// write a row.
const OUTSIDE_RUNTIME = /^apps\/api\/src\/(?:dev|scripts|tests)\//u;

// An ISO step alone admits days that do not exist, year zero and instants
// outside the years the API stores.
const UNCHECKED_STEPS = [
  /v\.isoDate\((?:"[^"]*")?\)(?!\s*,\s*API_CALENDAR_DATE_CHECK)/gu,
  /v\.isoTimestamp\((?:"[^"]*")?\)(?!\s*,\s*API_STORABLE_INSTANT_CHECK)/gu,
];

describe("API dates and date-times", () => {
  test("every valibot isoDate or isoTimestamp step in an API schema is followed by its check", async () => {
    const offenders: string[] = [];
    for (const root of SCHEMA_ROOTS) {
      const glob = new Bun.Glob("**/*.ts");
      for await (const file of glob.scan({
        cwd: nodePath.join(repoRoot, root),
      })) {
        const relative = `${root}/${file}`;
        if (
          relative === OWNER ||
          relative.endsWith(".test.ts") ||
          OUTSIDE_RUNTIME.test(relative)
        ) {
          continue;
        }
        const source = await Bun.file(nodePath.join(repoRoot, relative)).text();
        for (const pattern of UNCHECKED_STEPS) {
          for (const match of source.matchAll(pattern)) {
            const line = source.slice(0, match.index).split("\n").length;
            offenders.push(`${relative}:${line}`);
          }
        }
      }
    }
    // Use `apiDateSchema` or `apiDateTimeSchema`, or put
    // `API_CALENDAR_DATE_CHECK` / `API_STORABLE_INSTANT_CHECK` right after
    // the ISO step (all from `@stll/api-contract/api-date`).
    expect(offenders).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import nodePath from "node:path";

const repoRoot = nodePath.resolve(import.meta.dir, "../../../../..");

// Where API schemas are written: the API itself and the contract package
// whose schemas it reads and answers with.
const SCHEMA_ROOTS = ["apps/api/src", "packages/api-contract/src"];
// The owner composes the check; everything else uses what it exports.
const OWNER = "packages/api-contract/src/api-date.ts";

// An ISO date step alone admits days that do not exist and year zero.
const UNCHECKED_ISO_DATE =
  /v\.isoDate\((?:"[^"]*")?\)(?!\s*,\s*API_CALENDAR_DATE_CHECK)/gu;

describe("API calendar dates", () => {
  test("every valibot isoDate step in an API schema is followed by the calendar check", async () => {
    const offenders: string[] = [];
    for (const root of SCHEMA_ROOTS) {
      const glob = new Bun.Glob("**/*.ts");
      for await (const file of glob.scan({
        cwd: nodePath.join(repoRoot, root),
      })) {
        const relative = `${root}/${file}`;
        if (relative === OWNER) {
          continue;
        }
        const source = await Bun.file(nodePath.join(repoRoot, relative)).text();
        for (const match of source.matchAll(UNCHECKED_ISO_DATE)) {
          const line = source.slice(0, match.index).split("\n").length;
          offenders.push(`${relative}:${line}`);
        }
      }
    }
    // Use `apiDateSchema`, or put `API_CALENDAR_DATE_CHECK` right after the
    // ISO date step (both from `@stll/api-contract/api-date`).
    expect(offenders).toEqual([]);
  });
});

import { describe, expect, test } from "bun:test";
import path from "node:path";

import type { ParsedList, SanctionsEntry } from "./entry";
import { parseEuList } from "./eu";
import { checkListReplacement, listStats } from "./replacement";
import type { ListStats } from "./replacement";

const FIXTURE = path.join(import.meta.dir, "fixtures", "eu.xml");

const excerpt = (await parseEuList(Bun.file(FIXTURE).stream())).unwrap();

const withEntries = (count: number): ParsedList => {
  const entries: SanctionsEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    const entry = excerpt.entries[index % excerpt.entries.length];
    if (entry !== undefined) {
      entries.push({ ...entry, sourceId: String(index) });
    }
  }
  return { version: excerpt.version, entries };
};

const edition = (entryCount: number): ListStats => ({
  source: "eu",
  publishedAt: "2026-09-01",
  entryCount,
});

describe("list replacement guard", () => {
  test("refuses a well-formed edition that lost most of its entries", async () => {
    // A real, well-formed file cut down to one record parses fine.
    const source = await Bun.file(FIXTURE).text();
    const first = source.indexOf("    <sanctionEntity ");
    const second = source.indexOf("    <sanctionEntity ", first + 1);
    const oneRecord = `${source.slice(0, second)}</export>\n`;
    const parsed = (
      await parseEuList(
        (async function* () {
          yield new TextEncoder().encode(oneRecord);
        })(),
      )
    ).unwrap();
    expect(parsed.entries).toHaveLength(1);

    const contracted = checkListReplacement({
      previous: edition(6000),
      next: parsed,
    });
    expect(contracted.isErr() && contracted.error.code).toBe("contracted");
    const firstEdition = checkListReplacement({ previous: null, next: parsed });
    expect(firstEdition.isErr() && firstEdition.error.code).toBe(
      "below-minimum",
    );
  });

  test("accepts ordinary delistings and growth", () => {
    for (const count of [5400, 6000, 6300]) {
      const next = withEntries(count);
      expect(
        checkListReplacement({ previous: edition(6000), next }).unwrap(),
      ).toEqual(listStats(next));
    }
    expect(
      checkListReplacement({
        previous: edition(6000),
        next: withEntries(5399),
      }).isErr(),
    ).toBe(true);
    expect(
      checkListReplacement({ previous: null, next: withEntries(3000) }).isOk(),
    ).toBe(true);
  });

  test("refuses to replace one source's edition with another's", () => {
    const result = checkListReplacement({
      previous: { ...edition(6000), source: "un" },
      next: withEntries(6000),
    });
    expect(result.isErr() && result.error.code).toBe("source-mismatch");
  });
});

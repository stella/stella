import { describe, expect, test } from "bun:test";
import path from "node:path";

import { checkListReplacement } from "./replacement";
import { DEFAULT_CUTOFF, buildScreeningIndex, screen } from "./screening";
import { parseSecoList, readSecoListVersion } from "./seco";

const FILE = path.join(import.meta.dir, "fixtures", "seco.xml");
const encoder = new TextEncoder();

async function* once(text: string) {
  yield encoder.encode(text);
}

const fixture = async () =>
  (await parseSecoList(Bun.file(FILE).stream())).unwrap();

describe("SECO consolidated list", () => {
  test("keeps active people, entities and vessels with their names and references", async () => {
    const parsed = await fixture();
    expect(parsed.version).toEqual({
      source: "ch",
      publishedAt: "2026-09-04",
      fileId: null,
    });
    expect(parsed.entries.map(({ sourceId }) => sourceId)).toEqual([
      "1000",
      "2000",
      "3000",
    ]);
    expect(parsed.entries.map(({ entityType }) => entityType)).toEqual([
      "person",
      "organisation",
      "vessel",
    ]);
    const person = parsed.entries[0];
    expect(person?.issuer).toBe("CH");
    expect(person?.names).toEqual([
      { name: "Alex Example", quality: "strong" },
      { name: "Alek Example", quality: "strong" },
      { name: "Алекс Example", quality: "strong" },
      { name: "Lex Example", quality: "weak" },
      { name: "Alex Former", quality: "strong" },
    ]);
    expect(person?.birthDates).toEqual([
      { precision: "day", year: 1975, month: 8, day: 12, circa: false },
      { precision: "month", year: 1975, month: 9, circa: true },
      { precision: "month-day", month: 2, day: 9, circa: false },
    ]);
    expect(person?.nationalities.map(({ code }) => code)).toEqual(["GB", "CA"]);
    expect(person?.identifiers).toContainEqual({
      kind: "passport",
      status: "listed",
      label: "passport",
      number: "P123456",
      country: { code: "GB", name: "United Kingdom" },
    });
    expect(person?.addresses[0]).toEqual({
      street: "1 Sample Street",
      city: "Example City",
      region: "Example Region",
      postalCode: "AB1 2CD",
      country: { code: "GB", name: "United Kingdom" },
    });
    expect(person?.programme).toBe("Sample regime");
    expect(person?.legalBasis).toBe(
      "Sample ordinance: article 1, annexe 1; Sample ordinance: article 2, annexe 2",
    );
    expect(person?.listedOn).toBe("2025-04-15");
  });

  test("screens a spelling variant and a yearless day/month conservatively", async () => {
    const index = buildScreeningIndex([await fixture()]);
    const hit = screen(
      index,
      { name: "Alek Example", birthDate: { year: 1980, month: 2, day: 9 } },
      { cutoff: DEFAULT_CUTOFF },
    ).unwrap().possibleMatches[0];
    expect(hit?.entry.sourceId).toBe("1000");
    expect(hit?.evidence.birthDate).toBe("match");
    const yearOnly = screen(
      index,
      { name: "Alex Example", birthDate: { year: 1980 } },
      { cutoff: DEFAULT_CUTOFF },
    ).unwrap().possibleMatches[0];
    expect(yearOnly?.evidence.birthDate).toBe("not-compared");
    expect(
      screen(
        index,
        { name: "Former Target" },
        { cutoff: DEFAULT_CUTOFF },
      ).unwrap().possibleMatches,
    ).toEqual([]);
    const lowDateXml = (await Bun.file(FILE).text()).replace(
      'ssid="1006" day="9" month="2" calendar="Gregorian" quality="good"',
      'ssid="1006" day="9" month="2" calendar="Gregorian" quality="low"',
    );
    const lowDateIndex = buildScreeningIndex([
      (await parseSecoList(once(lowDateXml))).unwrap(),
    ]);
    const uncertain = screen(
      lowDateIndex,
      { name: "Alex Example", birthDate: { year: 1980, month: 3, day: 10 } },
      { cutoff: DEFAULT_CUTOFF },
    ).unwrap().possibleMatches[0];
    expect(uncertain?.evidence.birthDate).toBe("not-compared");
  });

  test("reads the root edition without consuming targets and guards replacements", async () => {
    const xml = await Bun.file(FILE).text();
    async function* headOnly() {
      yield encoder.encode(xml.slice(0, xml.indexOf("  <sanctions-program")));
      throw new Error("read beyond root");
    }
    expect((await readSecoListVersion(headOnly())).unwrap().publishedAt).toBe(
      "2026-09-04",
    );
    const parsed = await fixture();
    const first = checkListReplacement({ previous: null, next: parsed });
    expect(first.isErr() && first.error.code).toBe("below-minimum");
    const contracted = checkListReplacement({
      previous: { source: "ch", publishedAt: "2026-09-01", entryCount: 100 },
      next: parsed,
    });
    expect(contracted.isErr() && contracted.error.code).toBe("contracted");
  });

  test("rejects broken source references, changed list kind and truncated input", async () => {
    const xml = await Bun.file(FILE).text();
    const badSet = await parseSecoList(
      once(
        xml.replace(
          "<sanctions-set-id>101</sanctions-set-id>",
          "<sanctions-set-id>999</sanctions-set-id>",
        ),
      ),
    );
    expect(badSet.isErr() && badSet.error.code).toBe("invalid-value");
    const badPlace = await parseSecoList(
      once(xml.replace('place-id="5000"', 'place-id="9999"')),
    );
    expect(badPlace.isErr() && badPlace.error.code).toBe("invalid-value");
    const wrongKind = await parseSecoList(
      once(xml.replace('list-type="whole-list"', 'list-type="delta"')),
    );
    expect(wrongKind.isErr() && wrongKind.error.code).toBe("invalid-value");
    const truncated = await parseSecoList(once(xml.slice(0, -20)));
    expect(truncated.isErr() && truncated.error.code).toBe("malformed-input");
  });

  test("parses across arbitrary byte boundaries", async () => {
    const bytes = encoder.encode(await Bun.file(FILE).text());
    async function* chunks() {
      for (let index = 0; index < bytes.length; index += 13) {
        yield bytes.slice(index, index + 13);
      }
    }
    expect((await parseSecoList(chunks())).unwrap()).toEqual(await fixture());
  });

  test("keeps unknown publisher types explicit", async () => {
    const xml = (await Bun.file(FILE).text())
      .replace(
        'name-type="alias" quality="low"',
        'name-type="alias" quality="new"',
      )
      .replace('object-type="vessel"', 'object-type="spacecraft"');
    const parsed = (await parseSecoList(once(xml))).unwrap();
    expect(parsed.entries[0]?.names[3]?.quality).toBe("unknown");
    expect(parsed.entries[2]?.entityType).toBe("unknown");
  });
});

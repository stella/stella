import { describe, expect, test } from "bun:test";
import path from "node:path";

import { checkListReplacement } from "./replacement";
import { DEFAULT_CUTOFF, buildScreeningIndex, screen } from "./screening";
import { parseUkList, readUkListVersion } from "./uk";

const FILE = path.join(import.meta.dir, "fixtures", "uk.xml");
const encoder = new TextEncoder();

async function* once(text: string) {
  yield encoder.encode(text);
}

/** The fixture with the first listed person's birth dates replaced. */
const withBirthDates = async (dates: readonly string[]) =>
  (await Bun.file(FILE).text()).replace(
    /<DOBs>.*<\/DOBs>/u,
    () => `<DOBs>${dates.map((date) => `<DOB>${date}</DOB>`).join("")}</DOBs>`,
  );

const fixture = async () =>
  (await parseUkList(Bun.file(FILE).stream())).unwrap();

describe("UK Sanctions List", () => {
  test("keeps names, partial birth dates and identifiers for each record kind", async () => {
    const parsed = await fixture();
    expect(parsed.version).toEqual({
      source: "uk",
      publishedAt: "2026-09-21",
      fileId: null,
    });
    expect(parsed.entries.map(({ entityType }) => entityType)).toEqual([
      "person",
      "organisation",
      "vessel",
    ]);
    const person = parsed.entries[0];
    expect(person?.issuer).toBe("GB");
    expect(person?.referenceNumber).toBe("100");
    expect(person?.listedOn).toBe("2025-04-15");
    expect(person?.names).toEqual([
      { name: "Alex Example", quality: "strong" },
      { name: "Alek Example", quality: "strong" },
      { name: "Lex Example", quality: "weak" },
      { name: "Алекс Пример", quality: "strong" },
    ]);
    expect(person?.birthDates).toEqual([
      { precision: "day", year: 1975, month: 8, day: 12, circa: false },
      { precision: "month", year: 1975, month: 9, circa: false },
      { precision: "year", year: 1975, circa: false },
      { precision: "year", year: 1975, circa: false },
      {
        precision: "year-range",
        fromYear: 1900,
        toYear: 1999,
        circa: false,
      },
    ]);
    expect(person?.nationalities.map(({ code }) => code)).toEqual(["GB", "CA"]);
    expect(person?.identifiers.map(({ kind }) => kind)).toEqual([
      "passport",
      "national-id",
      "other",
    ]);
    expect(person?.addresses[0]).toEqual({
      street: "1 Sample Street, Example City",
      city: null,
      region: null,
      postalCode: "AB1 2CD",
      country: { code: "GB", name: "United Kingdom" },
    });
    expect(parsed.entries[1]?.identifiers[0]?.kind).toBe("registration");
    expect(parsed.entries[2]?.identifiers[0]?.kind).toBe("imo");
  });

  test("reads only the publication date and rejects malformed or incomplete XML", async () => {
    const xml = await Bun.file(FILE).text();
    const head = xml.slice(0, xml.indexOf("  <Designation>"));
    async function* headOnly() {
      yield encoder.encode(head);
      throw new Error("read past the edition stamp");
    }
    expect((await readUkListVersion(headOnly())).unwrap().publishedAt).toBe(
      "2026-09-21",
    );
    expect(
      (
        await readUkListVersion(
          once(`${head}<Designation><broken></Designation>`),
        )
      ).unwrap().publishedAt,
    ).toBe("2026-09-21");
    expect((await parseUkList(once("<Designations/>"))).isErr()).toBe(true);
    const truncated = await parseUkList(once(xml.slice(0, -20)));
    expect(truncated.isErr() && truncated.error.code).toBe("malformed-input");
    const invalidDate = await parseUkList(
      once(xml.replace("21/09/2026", "31/02/2026")),
    );
    expect(invalidDate.isErr() && invalidDate.error.code).toBe("invalid-value");
  });

  test("leaves out birth dates whose year the list does not know", async () => {
    const xml = await withBirthDates([
      "dd/mm/yyyy",
      "00/00/0000",
      "dd/mm/0000",
      "dd/08/0000",
      "12/08/0000",
      "0000",
      "00yy",
    ]);
    const parsed = (await parseUkList(once(xml))).unwrap();
    const person = parsed.entries.find(({ sourceId }) => sourceId === "UK-100");
    expect(person?.birthDates).toEqual([]);

    const index = buildScreeningIndex([parsed]);
    const match = screen(
      index,
      { name: "Alex Example", birthDate: { year: 1980, month: 1, day: 2 } },
      { cutoff: DEFAULT_CUTOFF },
    )
      .unwrap()
      .possibleMatches.find(({ entry }) => entry.sourceId === "UK-100");
    expect(match?.evidence.birthDate).toBe("not-compared");
    expect(match?.evidence.conflicts).toEqual([]);
  });

  test("keeps the known year of a date with an unknown month and rejects impossible parts", async () => {
    const person = (
      await parseUkList(
        once(await withBirthDates(["12/mm/1975", "12/00/1975"])),
      )
    )
      .unwrap()
      .entries.find(({ sourceId }) => sourceId === "UK-100");
    expect(person?.birthDates).toEqual([
      { precision: "year", year: 1975, circa: false },
      { precision: "year", year: 1975, circa: false },
    ]);
    for (const invalid of ["dd/13/1975", "31/02/1975", "1975-08-12"]) {
      const parsed = await parseUkList(once(await withBirthDates([invalid])));
      expect(parsed.isErr() && parsed.error.code).toBe("invalid-value");
    }
  });

  test("parses across arbitrary byte boundaries and guards replacement counts", async () => {
    const bytes = encoder.encode(await Bun.file(FILE).text());
    async function* chunks() {
      for (let index = 0; index < bytes.length; index += 11) {
        yield bytes.slice(index, index + 11);
      }
    }
    const parsed = await fixture();
    expect((await parseUkList(chunks())).unwrap()).toEqual(parsed);
    const first = checkListReplacement({ previous: null, next: parsed });
    expect(first.isErr() && first.error.code).toBe("below-minimum");
    const contracted = checkListReplacement({
      previous: { source: "uk", publishedAt: "2026-09-01", entryCount: 100 },
      next: parsed,
    });
    expect(contracted.isErr() && contracted.error.code).toBe("contracted");
  });

  test("keeps unrecognised publisher types explicit", async () => {
    const xml = (await Bun.file(FILE).text())
      .replace(
        "<Name1>Lex</Name1><Name6>Example</Name6><NameType>Alias</NameType>",
        "<Name1>Lex</Name1><Name6>Example</Name6><NameType>New alias type</NameType>",
      )
      .replace(
        "<IndividualEntityShip>Ship</IndividualEntityShip>",
        "<IndividualEntityShip>Aircraft</IndividualEntityShip>",
      );
    const parsed = (await parseUkList(once(xml))).unwrap();
    expect(parsed.entries[0]?.names[2]?.quality).toBe("unknown");
    expect(parsed.entries[2]?.entityType).toBe("unknown");
  });

  test("makes the publisher's identifiers and aliases searchable", async () => {
    const index = buildScreeningIndex([await fixture()]);
    expect(
      screen(
        index,
        { name: "Alek Example" },
        { cutoff: DEFAULT_CUTOFF },
      ).unwrap().possibleMatches[0]?.entry.sourceId,
    ).toBe("UK-100");
    expect(
      screen(
        index,
        { name: "", identifiers: ["1234567"] },
        { cutoff: DEFAULT_CUTOFF },
      ).unwrap().possibleMatches[0]?.entry.sourceId,
    ).toBe("UK-300");
  });
});

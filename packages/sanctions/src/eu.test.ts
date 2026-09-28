import { describe, expect, test } from "bun:test";
import path from "node:path";

import { parseEuList, readEuListVersion } from "./eu";

const FIXTURE = path.join(import.meta.dir, "fixtures", "eu.xml");
const encoder = new TextEncoder();

const fixtureBytes = async () =>
  new Uint8Array(await Bun.file(FIXTURE).arrayBuffer());

async function* chunks(bytes: Uint8Array, size: number) {
  for (let offset = 0; offset < bytes.length; offset += size) {
    yield bytes.subarray(offset, offset + size);
  }
}

const parseText = async (xml: string) =>
  await parseEuList(chunks(encoder.encode(xml), 4096));

const entryById = async (sourceId: string) => {
  const parsed = (await parseEuList(Bun.file(FIXTURE).stream())).unwrap();
  const entry = parsed.entries.find(
    (candidate) => candidate.sourceId === sourceId,
  );
  if (entry === undefined) {
    throw new Error(`fixture has no entry ${sourceId}`);
  }
  return entry;
};

describe("EU consolidated list parser", () => {
  test("reads the edition stamp and every entry of the excerpt", async () => {
    const parsed = (await parseEuList(Bun.file(FIXTURE).stream())).unwrap();
    const source = await Bun.file(FIXTURE).text();
    expect(parsed.version).toEqual({
      source: "eu",
      publishedAt: "2026-09-22T20:01:34.799+02:00",
      fileId: "185564",
    });
    expect(parsed.entries).toHaveLength(
      source.match(/<sanctionEntity /gu)?.length ?? -1,
    );
  });

  test("keeps every alias script and the designating act", async () => {
    const putin = await entryById("135909");
    expect(putin.entityType).toBe("person");
    expect(putin.names.map(({ name }) => name)).toContain(
      "Vladimir Vladimirovich PUTIN",
    );
    expect(
      putin.names.some(({ name }) => /\p{Script=Cyrillic}/u.test(name)),
    ).toBe(true);
    expect(putin.birthDates).toEqual([
      { precision: "day", year: 1952, month: 10, day: 7, circa: false },
    ]);
    expect(putin.programme).toBe("UKR");
    expect(putin.sourceUrl).toStartWith("https://eur-lex.europa.eu/");
  });

  test("reads birth dates at the precision the list states", async () => {
    const monthOnly = await entryById("6971");
    expect(
      monthOnly.birthDates.some((date) => date.precision === "month"),
    ).toBe(true);

    const range = await entryById("521");
    expect(range.birthDates).toContainEqual({
      precision: "year-range",
      fromYear: 1953,
      toYear: 1958,
      circa: true,
    });
  });

  test("never reads a Hijri year as a Gregorian one", async () => {
    const source = await Bun.file(FIXTURE).text();
    // The excerpt lists solar Hijri 1343 next to Gregorian 1964 and 1965.
    expect(source).toContain(
      'calendarType="ISLAMIC" city="Farsan" zipCode="" year="1343"',
    );

    const entry = await entryById("127388");
    expect(entry.birthDates).toEqual([
      { precision: "year", year: 1965, circa: false },
      { precision: "year", year: 1964, circa: false },
    ]);
  });

  test("maps identifiers to their kind and skips the unknown-country placeholder", async () => {
    const company = await entryById("3826");
    expect(company.entityType).toBe("organisation");
    expect(
      company.identifiers.some(
        (identifier) => identifier.kind === "registration",
      ),
    ).toBe(true);
    const everyCountry = [
      ...company.nationalities,
      ...company.identifiers.flatMap((identifier) => identifier.country ?? []),
      ...company.addresses.flatMap((address) => address.country ?? []),
    ];
    expect(everyCountry.every((country) => country.name !== "UNKNOWN")).toBe(
      true,
    );
  });

  test("gives the same result however the bytes are chunked", async () => {
    const bytes = await fixtureBytes();
    const whole = (await parseEuList(chunks(bytes, bytes.length))).unwrap();
    // Small odd sizes split multi-byte UTF-8 characters and tags across chunks.
    for (const size of [1, 7, 97, 1021]) {
      expect((await parseEuList(chunks(bytes, size))).unwrap()).toEqual(whole);
    }
  });

  test("fails a truncated file instead of returning the entries read so far", async () => {
    const source = await Bun.file(FIXTURE).text();
    const lastEntryEnd =
      source.lastIndexOf("</sanctionEntity>") + "</sanctionEntity>".length;
    for (const cut of [0.1, 0.5, 0.9].map((share) =>
      Math.floor(source.length * share),
    )) {
      const result = await parseText(source.slice(0, cut));
      expect(result.isErr() && result.error.code).toBe("malformed-input");
    }
    // Every entry is complete here; only the closing root tag is missing.
    const unclosed = await parseText(source.slice(0, lastEntryEnd));
    expect(unclosed.isErr() && unclosed.error.code).toBe("malformed-input");
  });

  test("rejects another document, an unknown subject type and an empty list", async () => {
    const wrongRoot = await parseText(
      '<?xml version="1.0"?><CONSOLIDATED_LIST/>',
    );
    expect(wrongRoot.isErr() && wrongRoot.error.code).toBe(
      "unexpected-structure",
    );

    const source = await Bun.file(FIXTURE).text();
    const vessel = await parseText(
      source.replace('code="person"', 'code="vessel"'),
    );
    expect(vessel.isErr() && vessel.error.code).toBe("invalid-value");

    const empty = await parseText(
      '<export xmlns="http://eu.europa.ec/fpi/fsd/export" generationDate="2026-01-01" globalFileId="1"></export>',
    );
    expect(empty.isErr() && empty.error.code).toBe("empty-list");
  });

  test("keeps a year range open at one end", async () => {
    // The full list has a row with only yearRangeTo ("born by 1980").
    const source = await Bun.file(FIXTURE).text();
    const rangeOf = async (edited: string) => {
      const parsed = (await parseText(edited)).unwrap();
      return parsed.entries.find((candidate) => candidate.sourceId === "521")
        ?.birthDates;
    };
    expect(
      await rangeOf(source.replace(' yearRangeFrom="1953"', "")),
    ).toContainEqual({
      precision: "year-range",
      fromYear: null,
      toYear: 1958,
      circa: true,
    });
    expect(
      await rangeOf(source.replace(' yearRangeTo="1958"', "")),
    ).toContainEqual({
      precision: "year-range",
      fromYear: 1953,
      toYear: null,
      circa: true,
    });
  });

  test("fails on birth dates it cannot read in full", async () => {
    const source = await Bun.file(FIXTURE).text();
    for (const broken of [
      // An unknown boolean.
      source.replace('circa="true"', 'circa="maybe"'),
      // A month without its year.
      source.replace('monthOfYear="8" year="1961"', 'monthOfYear="8"'),
      // A month past December.
      source.replace(
        'monthOfYear="8" year="1961"',
        'monthOfYear="13" year="1961"',
      ),
      // An edition stamp that is not a date.
      source.replace(/generationDate="[^"]*"/u, 'generationDate="yesterday"'),
      // A year and a range at once.
      source.replace(
        'yearRangeFrom="1953"',
        'year="1950" yearRangeFrom="1953"',
      ),
      // A Hijri year with no Gregorian date beside it.
      source
        .replace(
          /\n\s*<birthdate [^>]*"Farsan" zipCode="" year="1965"[^>]*>[\s\S]*?<\/birthdate>/u,
          "",
        )
        .replace(
          /\n\s*<birthdate [^>]*"Farsan" zipCode="" year="1964"[^>]*>[\s\S]*?<\/birthdate>/u,
          "",
        ),
    ]) {
      expect(broken).not.toBe(source);
      const result = await parseText(broken);
      expect(result.isErr() && result.error.code).toBe("invalid-value");
    }
  });

  test("keeps the list's known-false flag on identifiers", async () => {
    const source = await Bun.file(FIXTURE).text();
    const flagged = source.replace('knownFalse="false"', 'knownFalse="true"');
    const parsed = (await parseText(flagged)).unwrap();
    const statuses = parsed.entries.flatMap((entry) =>
      entry.identifiers.map((identifier) => identifier.status),
    );
    expect(statuses.filter((status) => status === "known-false")).toHaveLength(
      1,
    );
    const unknown = await parseText(
      source.replace('knownFalse="false"', 'knownFalse="unclear"'),
    );
    expect(unknown.isErr() && unknown.error.code).toBe("invalid-value");
  });

  test("fails on a record element it does not know instead of skipping it", async () => {
    const source = await Bun.file(FIXTURE).text();
    const renamed = source
      .replace("<sanctionEntity ", "<renamedEntity ")
      .replace("</sanctionEntity>", "</renamedEntity>");
    // Still well formed, and every other record is valid.
    expect(renamed.match(/<sanctionEntity /gu)?.length).toBeGreaterThan(1);
    const result = await parseText(renamed);
    expect(result.isErr() && result.error.code).toBe("unexpected-structure");
  });

  test("reads the edition without consuming the rest of the stream", async () => {
    const bytes = await fixtureBytes();
    let pulled = 0;
    async function* headThenGarbage() {
      pulled += 1;
      yield bytes.subarray(0, 512);
      pulled += 1;
      yield encoder.encode("<<< not xml");
    }
    const version = (await readEuListVersion(headThenGarbage())).unwrap();
    expect(version.fileId).toBe("185564");
    expect(pulled).toBe(1);
  });
});

import { describe, expect, test } from "bun:test";
import path from "node:path";

import { parseOfacList, readOfacListVersion } from "./ofac";
import { checkListReplacement } from "./replacement";
import { DEFAULT_CUTOFF, buildScreeningIndex, screen } from "./screening";

const SDN = path.join(import.meta.dir, "fixtures", "ofac-sdn.xml");
const NON_SDN = path.join(import.meta.dir, "fixtures", "ofac-non-sdn.xml");
const encoder = new TextEncoder();

async function* once(text: string) {
  yield encoder.encode(text);
}

const sdn = async () =>
  (await parseOfacList("us-sdn", Bun.file(SDN).stream())).unwrap();
const nonSdn = async () =>
  (await parseOfacList("us-non-sdn", Bun.file(NON_SDN).stream())).unwrap();

describe("OFAC XML lists", () => {
  test("keeps SDN names, dates, identifiers, programmes and vessel and aircraft types", async () => {
    const parsed = await sdn();
    expect(parsed.version).toEqual({
      source: "us-sdn",
      publishedAt: "2026-09-23",
      fileId: null,
    });
    expect(parsed.entries).toHaveLength(4);
    const person = parsed.entries[0];
    expect(person?.issuer).toBe("US");
    expect(person?.names).toEqual([
      { name: "Alexei PETROV", quality: "strong" },
      { name: "Aleksei PETROV", quality: "strong" },
      { name: "ALPHA", quality: "weak" },
    ]);
    expect(person?.birthDates).toEqual([
      { precision: "day", year: 1948, month: 12, day: 10, circa: false },
      { precision: "year", year: 1951, circa: true },
      { precision: "month", year: 1952, month: 9, circa: false },
    ]);
    expect(person?.nationalities.map(({ code }) => code)).toEqual(["RU", "CA"]);
    expect(person?.programme).toBe("CYBER2; RUSSIA-EO14024");
    expect(person?.identifiers).toContainEqual({
      kind: "passport",
      status: "listed",
      label: "Passport",
      number: "AB1234567",
      country: { code: "RU", name: "Russian Federation" },
    });
    expect(person?.identifiers).toContainEqual({
      kind: "unknown",
      status: "listed",
      label: "Gender",
      number: "Male",
      country: null,
    });
    expect(person?.addresses[0]?.street).toBe("10 Main Street, Suite 2");
    expect(parsed.entries.map(({ entityType }) => entityType)).toEqual([
      "person",
      "organisation",
      "vessel",
      "aircraft",
    ]);
    expect(parsed.entries[2]?.identifiers.map(({ number }) => number)).toEqual([
      "9187629",
      "CL2192",
    ]);
    expect(parsed.entries[3]?.identifiers[0]?.kind).toBe("other");
  });

  test("keeps non-SDN aliases, month and year ranges, and separate source identity", async () => {
    const parsed = await nonSdn();
    expect(parsed.version).toEqual({
      source: "us-non-sdn",
      publishedAt: "2026-09-14",
      fileId: null,
    });
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.entries[0]?.names[1]?.name).toBe("Maryam HASSAN");
    expect(parsed.entries[0]?.birthDates).toEqual([
      { precision: "year-range", fromYear: 1952, toYear: 1952, circa: false },
      { precision: "year-range", fromYear: 1960, toYear: 1962, circa: false },
    ]);
    expect(parsed.entries[1]?.identifiers.map(({ kind }) => kind)).toEqual([
      "registration",
      "unknown",
    ]);
    expect(parsed.entries[1]?.source).toBe("us-non-sdn");
  });

  test("stops after publication metadata and rejects a wrong record count", async () => {
    const xml = await Bun.file(SDN).text();
    const head = xml.slice(0, xml.indexOf("  <sdnEntry>"));
    async function* headOnly() {
      yield encoder.encode(head);
      throw new Error("read past publication metadata");
    }
    expect(
      (await readOfacListVersion("us-sdn", headOnly())).unwrap().publishedAt,
    ).toBe("2026-09-23");
    const mismatch = await parseOfacList(
      "us-sdn",
      once(
        xml.replace(
          "<Record_Count>4</Record_Count>",
          "<Record_Count>5</Record_Count>",
        ),
      ),
    );
    expect(mismatch.isErr() && mismatch.error.code).toBe(
      "unexpected-structure",
    );
    const truncated = await parseOfacList(
      "us-sdn",
      once(xml.slice(0, xml.indexOf("  <sdnEntry>") + 20)),
    );
    expect(truncated.isErr() && truncated.error.code).toBe("malformed-input");
  });

  test("parses the same records across arbitrary byte boundaries", async () => {
    const xml = encoder.encode(await Bun.file(SDN).text());
    async function* chunks() {
      for (let index = 0; index < xml.length; index += 7) {
        yield xml.slice(index, index + 7);
      }
    }
    expect((await parseOfacList("us-sdn", chunks())).unwrap()).toEqual(
      await sdn(),
    );
  });

  test("keeps an unrecognised publisher category explicit", async () => {
    const xml = await Bun.file(SDN).text();
    const changed = xml
      .replace("<category>weak</category>", "<category>new-grade</category>")
      .replace("<sdnType>Aircraft</sdnType>", "<sdnType>Spacecraft</sdnType>");
    const parsed = (await parseOfacList("us-sdn", once(changed))).unwrap();
    expect(parsed.entries[0]?.names[2]?.quality).toBe("unknown");
    expect(parsed.entries[3]?.entityType).toBe("unknown");
  });

  test("reports names and true identifiers without treating metadata as an ID", async () => {
    const index = buildScreeningIndex([await sdn(), await nonSdn()]);
    const match = screen(
      index,
      { name: "Aleksei Petrov", entityType: "person" },
      { cutoff: DEFAULT_CUTOFF },
    ).unwrap();
    expect(match.possibleMatches[0]?.entry.sourceId).toBe("10001");
    expect(
      screen(
        index,
        { name: "", identifiers: ["9187629"] },
        { cutoff: DEFAULT_CUTOFF },
      ).unwrap().possibleMatches[0]?.entry.entityType,
    ).toBe("vessel");
    expect(
      screen(
        index,
        { name: "", identifiers: ["east.example"] },
        { cutoff: DEFAULT_CUTOFF },
      ).unwrap().possibleMatches,
    ).toEqual([]);
    expect(
      screen(
        index,
        { name: "Maryam Hassan" },
        { cutoff: DEFAULT_CUTOFF },
      ).unwrap().possibleMatches[0]?.entry.source,
    ).toBe("us-non-sdn");
  });

  test("refuses implausible replacement counts and older editions for each list", async () => {
    for (const parsed of [await sdn(), await nonSdn()]) {
      const first = checkListReplacement({ previous: null, next: parsed });
      expect(first.isErr() && first.error.code).toBe("below-minimum");
      const contracted = checkListReplacement({
        previous: {
          source: parsed.version.source,
          publishedAt: "2026-09-01",
          entryCount: parsed.entries.length * 10,
        },
        next: parsed,
      });
      expect(contracted.isErr() && contracted.error.code).toBe("contracted");
      const stale = checkListReplacement({
        previous: {
          source: parsed.version.source,
          publishedAt: "2026-10-01",
          entryCount: parsed.entries.length,
        },
        next: parsed,
      });
      expect(stale.isErr() && stale.error.code).toBe("stale");
    }
  });
});

import { describe, expect, test } from "bun:test";
import path from "node:path";

import { parseUnList, readUnListVersion } from "./un";

const FIXTURE = path.join(import.meta.dir, "fixtures", "un.xml");
const encoder = new TextEncoder();

async function* once(text: string) {
  yield encoder.encode(text);
}

const parsedFixture = async () =>
  (await parseUnList(Bun.file(FIXTURE).stream())).unwrap();

const entryById = async (sourceId: string) => {
  const entry = (await parsedFixture()).entries.find(
    (candidate) => candidate.sourceId === sourceId,
  );
  if (entry === undefined) {
    throw new Error(`fixture has no entry ${sourceId}`);
  }
  return entry;
};

describe("UN consolidated list parser", () => {
  test("reads individuals and entities with the list's generation stamp", async () => {
    const parsed = await parsedFixture();
    const source = await Bun.file(FIXTURE).text();
    expect(parsed.version).toEqual({
      source: "un",
      publishedAt: "2026-09-26T23:00:05.647Z",
      fileId: null,
    });
    const individuals = source.match(/<INDIVIDUAL>/gu)?.length ?? -1;
    const organisations = source.match(/<ENTITY>/gu)?.length ?? -1;
    expect(
      parsed.entries.filter((entry) => entry.entityType === "person"),
    ).toHaveLength(individuals);
    expect(
      parsed.entries.filter((entry) => entry.entityType === "organisation"),
    ).toHaveLength(organisations);
  });

  test("marks low-quality aliases weak and keeps former names strong", async () => {
    const ntaganda = await entryById("6908021");
    expect(ntaganda.names.at(0)).toEqual({
      name: "BOSCO TAGANDA",
      quality: "strong",
    });
    expect(ntaganda.names).toContainEqual({
      name: "Terminator",
      quality: "weak",
    });
    expect(ntaganda.birthDates).toEqual([
      { precision: "year-range", fromYear: 1973, toYear: 1974, circa: false },
    ]);
    expect(ntaganda.nationalities).toEqual([
      { code: "CD", name: "Democratic Republic of the Congo" },
    ]);

    const adf = await entryById("6908402");
    expect(adf.entityType).toBe("organisation");
    expect(adf.names).toContainEqual({ name: "NALU", quality: "strong" });
  });

  test("keeps original-script names, approximate years and alias birth dates", async () => {
    const saddam = await entryById("6908048");
    expect(
      saddam.names.some(({ name }) => /\p{Script=Arabic}/u.test(name)),
    ).toBe(true);

    const approximate = await entryById("6908006");
    expect(approximate.birthDates.some((date) => date.circa)).toBe(true);

    // This alias carries a year-only birth date of its own.
    const umarov = await entryById("2960872");
    expect(umarov.birthDates).toContainEqual({
      precision: "year",
      year: 1955,
      circa: false,
    });
  });

  test("normalises a listing date written with a timezone", async () => {
    const source = await Bun.file(FIXTURE).text();
    expect(source).toContain("<LISTED_ON>2015-07-01-04:00</LISTED_ON>");
    const entry = await entryById("6908457");
    expect(entry.listedOn).toBe("2015-07-01");
  });

  test("records passports with their issuing country", async () => {
    const entry = await entryById("6908012");
    const passport = entry.identifiers.find(
      (identifier) => identifier.kind === "passport",
    );
    expect(passport?.number).toBeString();
    expect(passport?.label).toBe("Passport");
  });

  test("fails on an alias quality the parser does not know", async () => {
    const source = await Bun.file(FIXTURE).text();
    const result = await parseUnList(
      once(
        source.replace("<QUALITY>Low</QUALITY>", "<QUALITY>Medium</QUALITY>"),
      ),
    );
    expect(result.isErr() && result.error.code).toBe("invalid-value");
  });

  test("fails on a record element it does not know instead of skipping it", async () => {
    const source = await Bun.file(FIXTURE).text();
    for (const [from, to] of [
      ["INDIVIDUAL>", "PERSON>"],
      ["ENTITY>", "ORGANISATION>"],
    ]) {
      // Renames one record, opening and closing tag, among valid ones.
      const renamed = source
        .replace(`<${from}`, () => `<${to}`)
        .replace(`</${from}`, () => `</${to}`);
      const result = await parseUnList(once(renamed));
      expect(result.isErr() && result.error.code).toBe("unexpected-structure");
    }
  });

  test("fails on a truncated file", async () => {
    const source = await Bun.file(FIXTURE).text();
    const result = await parseUnList(
      once(source.slice(0, source.lastIndexOf("</ENTITIES>"))),
    );
    expect(result.isErr() && result.error.code).toBe("malformed-input");
  });

  test("reads the edition from the head of the file", async () => {
    const source = await Bun.file(FIXTURE).text();
    const head = source.slice(0, source.indexOf("<INDIVIDUAL>"));
    const version = (await readUnListVersion(once(head))).unwrap();
    expect(version.publishedAt).toBe("2026-09-26T23:00:05.647Z");
  });
});

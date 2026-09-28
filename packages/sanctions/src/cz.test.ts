import { describe, expect, test } from "bun:test";
import path from "node:path";

import { parseCzList, readCzListVersion } from "./cz";

const FILE_NAME = "Vnitrostatni_sankcni_seznam_2026_07_23.csv";
const DOWNLOAD_URL = `https://mzv.gov.cz/file/6248997/${FILE_NAME}`;
const FIXTURE = path.join(import.meta.dir, "fixtures", FILE_NAME);

const scripts = ["Latin", "Cyrillic", "Georgian", "Arabic"];
const scriptsOf = (text: string) =>
  scripts.filter((script) =>
    new RegExp(`\\p{Script=${script}}`, "u").test(text),
  );

describe("Czech national sanctions list parser", () => {
  test("takes the edition from the published file name", () => {
    expect(readCzListVersion(DOWNLOAD_URL).unwrap()).toEqual({
      source: "cz",
      publishedAt: "2026-07-23",
      fileId: "6248997",
    });
    expect(readCzListVersion(FILE_NAME).unwrap().fileId).toBeNull();
    const undated = readCzListVersion("sankcni_seznam.csv");
    expect(undated.isErr() && undated.error.code).toBe("missing-field");
    const impossible = readCzListVersion(
      "Vnitrostatni_sankcni_seznam_2026_02_30.csv",
    );
    expect(impossible.isErr() && impossible.error.code).toBe("invalid-value");
  });

  test("keeps only designations in force", async () => {
    const csv = await Bun.file(FIXTURE).text();
    const parsed = parseCzList({ csv, fileNameOrUrl: DOWNLOAD_URL }).unwrap();
    const inForce = csv
      .split("\n")
      .filter((row) => row.includes('"platný"')).length;
    expect(inForce).toBeGreaterThan(0);
    expect(parsed.entries).toHaveLength(inForce);
    // Revoked once the EU listed him; the row stays in the file as history.
    expect(csv).toContain("JEVTUŠENKO");
    expect(
      parsed.entries.some((entry) => entry.sourceId.startsWith("JEVTUŠENKO")),
    ).toBe(false);
  });

  test("pairs surname and given-name transcriptions within one script", async () => {
    const csv = await Bun.file(FIXTURE).text();
    const parsed = parseCzList({ csv, fileNameOrUrl: FILE_NAME }).unwrap();
    const gundyaev = parsed.entries.find((entry) =>
      entry.sourceId.startsWith("GUNĎAJEV"),
    );
    expect(gundyaev?.names.map(({ name }) => name)).toEqual([
      "Vladimir Michajlovič GUNĎAJEV",
      "Vladimir Mikhailovich GUNĎAJEV",
      "Vladimir Michajlovič GUNDYAYEV",
      "Vladimir Mikhailovich GUNDYAYEV",
      "Владимир Михайлович ГУНДЯЕВ",
    ]);
    expect(gundyaev?.birthDates).toEqual([
      { precision: "day", year: 1946, month: 11, day: 20, circa: false },
    ]);
    expect(gundyaev?.nationalities).toEqual([
      { code: "RU", name: "Ruská federace" },
    ]);
    for (const entry of parsed.entries) {
      for (const { name } of entry.names) {
        expect(scriptsOf(name)).toHaveLength(1);
      }
    }
  });

  test("reads rows without a given name as organisations with a seat", async () => {
    const csv = await Bun.file(FIXTURE).text();
    const parsed = parseCzList({ csv, fileNameOrUrl: FILE_NAME }).unwrap();
    const voice = parsed.entries.find(
      (entry) => entry.sourceId === "Voice of Europe s.r.o.",
    );
    expect(voice?.entityType).toBe("organisation");
    expect(voice?.nationalities).toEqual([]);
    expect(voice?.addresses.map((address) => address.country?.code)).toEqual([
      "CZ",
    ]);
    expect(voice?.legalBasis).toStartWith("Usnesení vlády č. 195");
  });

  test("fails on a changed header, an unknown status or a broken quote", async () => {
    const csv = await Bun.file(FIXTURE).text();
    const renamed = parseCzList({
      csv: csv.replace("Stav zápisu", "Status"),
      fileNameOrUrl: FILE_NAME,
    });
    expect(renamed.isErr() && renamed.error.code).toBe("unexpected-structure");

    const status = parseCzList({
      csv: csv.replace('"platný"', '"pozastaven"'),
      fileNameOrUrl: FILE_NAME,
    });
    expect(status.isErr() && status.error.code).toBe("invalid-value");

    const unterminated = parseCzList({
      csv: csv.slice(0, csv.lastIndexOf('"')),
      fileNameOrUrl: FILE_NAME,
    });
    expect(unterminated.isErr() && unterminated.error.code).toBe(
      "malformed-input",
    );
  });
});

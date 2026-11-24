import { describe, expect, test } from "bun:test";

import { FILE_PART_KINDS } from "@stll/api-contract/file-parts";
import { ZIP_FILE_FORMAT } from "@stll/api-contract/legal-file-formats";
import {
  decodeDosCodePage,
  encodeDosCodePage,
} from "@stll/mojibake/dos-code-pages";

import { readZipArchivePreview } from "@/api/lib/files/archive-preview";
import { readPartOfFile } from "@/api/lib/files/file-part";
import { extractFileTextResult } from "@/api/lib/search/extract-content";
import { makeZipArchive } from "@/api/tests/fixtures/zip-archive";
import { testScannedFile } from "@/api/tests/helpers/scanned-file";

import {
  ZIP_NAME_CODE_PAGES,
  type ZipNameCodePage,
  zipNameCodePageFor,
  zipNameCodePageFromEnv,
} from "./zip-name-code-page";

describe("an organization's ZIP name code page", () => {
  test("is 852 when it practises in Czechia, Slovakia, Poland or Hungary", () => {
    for (const countryCode of ["CZ", "SK", "PL", "HU"]) {
      expect(zipNameCodePageFor([countryCode])).toBe("ibm852");
      expect(zipNameCodePageFor(["US", countryCode.toLowerCase()])).toBe(
        "ibm852",
      );
    }
  });

  test("is 437, the specification's, anywhere else or nowhere yet", () => {
    for (const countries of [[], ["DE"], ["AT", "US", "GB"], ["SI", "HR"]]) {
      expect(zipNameCodePageFor(countries)).toBe("ibm437");
    }
  });
});

describe("the code page a worker run is given", () => {
  test("is read back as given, and as 437 when none is", () => {
    for (const codePage of ZIP_NAME_CODE_PAGES) {
      expect(zipNameCodePageFromEnv(codePage)).toBe(codePage);
    }
    expect(zipNameCodePageFromEnv(undefined)).toBe("ibm437");
  });

  test("refuses one the API never writes", () => {
    for (const value of ["", "IBM852", "windows-1250", "cp852"]) {
      expect(() => zipNameCodePageFromEnv(value)).toThrow(
        "unknown ZIP name code page",
      );
    }
  });
});

describe("a ZIP name that reads alike in 437 and 852", () => {
  // "Důkazy.pdf" written in 852 without the UTF-8 flag: its one byte above
  // 0x7F is "ů" in 852 and "à" in 437, so the scoring ties.
  const TIED = encodeDosCodePage("Důkazy.pdf", "ibm852") ?? new Uint8Array();
  const READINGS = {
    ibm852: "Důkazy.pdf",
    ibm437: "Dàkazy.pdf",
  } as const satisfies Record<ZipNameCodePage, string>;
  const otherThan = (codePage: ZipNameCodePage): ZipNameCodePage =>
    codePage === "ibm852" ? "ibm437" : "ibm852";

  const zip = (bytes: Uint8Array, name: string) =>
    testScannedFile({
      bytes: new Uint8Array(bytes).buffer,
      mimeType: ZIP_FILE_FORMAT.mimeType,
      path: name,
    });

  test("the fixture ties: each code page reads its byte as a letter", () => {
    expect(decodeDosCodePage(TIED, "ibm852")).toBe(READINGS.ibm852);
    expect(decodeDosCodePage(TIED, "ibm437")).toBe(READINGS.ibm437);
  });

  test("reads in the code page each worker mode is handed", async () => {
    const outer = makeZipArchive([
      { name: TIED, data: "Seznam důkazů ke sporu", flags: 0 },
      {
        name: "spis.zip",
        data: makeZipArchive([{ name: TIED, data: "Důkaz", flags: 0 }]),
        method: 0,
      },
    ]);
    const source = zip(outer, "dukazy-ke-sporu.zip");
    for (const codePage of ZIP_NAME_CODE_PAGES) {
      const reading = READINGS[codePage];
      // The archive preview.
      const preview = (
        await readZipArchivePreview(source, { zipNameCodePage: codePage })
      ).unwrap();
      expect(preview.files.map(({ fileName }) => fileName)).toEqual([
        reading,
        "spis.zip",
      ]);
      // Text extraction, the archive inside the archive included.
      const text = (
        await extractFileTextResult(source, { zipNameCodePage: codePage })
      ).unwrap();
      expect(text).toContain(reading);
      expect(text).not.toContain(READINGS[otherThan(codePage)]);
      // A part of the archive inside, read down its path.
      const part = (
        await readPartOfFile(
          source,
          {
            kind: FILE_PART_KINDS.member,
            index: 0,
            within: { kind: FILE_PART_KINDS.member, index: 1 },
          },
          codePage,
        )
      ).unwrap();
      expect(part.fileName).toBe(reading);
    }
  });
});

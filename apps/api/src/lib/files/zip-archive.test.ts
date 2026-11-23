import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { encodeText } from "@stll/mojibake/charsets";
import { encodeDosCodePage } from "@stll/mojibake/dos-code-pages";
import { assertProperty } from "@stll/property-testing";

import {
  makeZipArchive,
  type RawZipEntry,
  unicodePathExtra,
  UNIX_DIRECTORY,
  UNIX_SYMLINK,
  unixExternalAttributes,
} from "@/api/tests/fixtures/zip-archive";

import {
  readZipArchive,
  readZipArchiveFile,
  ZIP_ARCHIVE_MAX_FILE_BYTES,
} from "./zip-archive";
import type { ZipNameCodePage } from "./zip-name-code-page";

const read = async (
  entries: readonly RawZipEntry[],
  nameCodePage: ZipNameCodePage = "ibm437",
) => (await readZipArchive(makeZipArchive(entries), { nameCodePage })).unwrap();

const listed = async (
  entries: readonly RawZipEntry[],
  nameCodePage?: ZipNameCodePage,
) =>
  (await read(entries, nameCodePage)).map(
    ({ fileName, folder, unavailable }) => ({
      fileName,
      folder,
      unavailable,
    }),
  );

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("a ZIP archive's files", () => {
  test("are its files in its order, with their folders, never its folders", async () => {
    const files = await read([
      {
        name: "spis/",
        externalAttributes: unixExternalAttributes(UNIX_DIRECTORY),
      },
      { name: "spis/žaloba.txt", data: "Žaloba o zaplacení 148 500 Kč" },
      {
        name: "spis/přílohy/smlouva o dílo.txt",
        data: "Smlouva o dílo č. 17/2026",
        method: 0,
      },
      { name: "plná moc.txt", data: "Plná moc pro Mgr. Hanu Vlčkovou" },
    ]);
    expect(
      files.map(({ fileName, folder, sizeBytes }) => ({
        fileName,
        folder,
        sizeBytes,
      })),
    ).toEqual([
      {
        fileName: "žaloba.txt",
        folder: "spis",
        sizeBytes: new TextEncoder().encode("Žaloba o zaplacení 148 500 Kč")
          .byteLength,
      },
      {
        fileName: "smlouva o dílo.txt",
        folder: "spis/přílohy",
        sizeBytes: new TextEncoder().encode("Smlouva o dílo č. 17/2026")
          .byteLength,
      },
      {
        fileName: "plná moc.txt",
        folder: null,
        sizeBytes: new TextEncoder().encode("Plná moc pro Mgr. Hanu Vlčkovou")
          .byteLength,
      },
    ]);
    expect(
      files.map((file) => text(readZipArchiveFile(file).unwrap())),
    ).toEqual([
      "Žaloba o zaplacení 148 500 Kč",
      "Smlouva o dílo č. 17/2026",
      "Plná moc pro Mgr. Hanu Vlčkovou",
    ]);
  });

  test("names climbing out of the archive are shown as stated, never as paths", async () => {
    expect(
      await listed([
        { name: "../../etc/passwd", data: "root" },
        { name: "/var/spool/podani.txt", data: "podání" },
        { name: "C:\\Spisy\\2026\\usneseni.txt", data: "usnesení" },
        { name: "spis/./../vyzva.txt", data: "výzva" },
      ]),
    ).toEqual([
      { fileName: "passwd", folder: "../../etc", unavailable: null },
      { fileName: "podani.txt", folder: "var/spool", unavailable: null },
      { fileName: "usneseni.txt", folder: "C:/Spisy/2026", unavailable: null },
      { fileName: "vyzva.txt", folder: "spis/./..", unavailable: null },
    ]);
  });

  test("Czech names without the UTF-8 flag read in the code page the archiver wrote", async () => {
    const names = [
      "Smlouva_o_dílo_Kratochvíl.pdf",
      "Předávací_protokol.docx",
      "Přílohy/Výpis_z_účtu.pdf",
    ];
    const expected = [
      { fileName: "Smlouva_o_dílo_Kratochvíl.pdf", folder: null },
      { fileName: "Předávací_protokol.docx", folder: null },
      { fileName: "Výpis_z_účtu.pdf", folder: "Přílohy" },
    ];
    // Windows' compressed folders and 7-Zip on Czech Windows write the OEM
    // code page, 852; some archivers write the ANSI one, windows-1250.
    const writtenBy = {
      oem: names.map((name) => encodeDosCodePage(name, "ibm852")),
      ansi: names.map((name) => encodeText(name, "windows-1250")),
    };
    for (const encoded of Object.values(writtenBy)) {
      const files = await read(
        encoded.map((name, index) => ({
          name: name ?? new Uint8Array(),
          data: `příloha ${String(index)}`,
          flags: 0,
        })),
      );
      expect(
        files.map(({ fileName, folder }) => ({ fileName, folder })),
      ).toEqual(expected);
    }
  });

  test("a name that reads alike in 437 and 852 reads in the code page the reader is given", async () => {
    // "ů" in 852 is the byte of "à" in 437, and both readings are letters
    // some scored language writes: a tie.
    const tied = encodeDosCodePage("Důkazy.pdf", "ibm852");
    expect(tied).toEqual(encodeDosCodePage("Dàkazy.pdf", "ibm437"));
    const entries = [{ name: tied ?? new Uint8Array(), data: "x", flags: 0 }];
    expect(
      (await listed(entries, "ibm852")).map(({ fileName }) => fileName),
    ).toEqual(["Důkazy.pdf"]);
    expect(
      (await listed(entries, "ibm437")).map(({ fileName }) => fileName),
    ).toEqual(["Dàkazy.pdf"]);
    // Names one code page explains better read alike whichever is given,
    // and a name the archive flags as UTF-8 is never weighed.
    const won = [
      {
        name:
          encodeDosCodePage("Procès-verbal_à_signer.pdf", "ibm437") ??
          new Uint8Array(),
        data: "x",
        flags: 0,
      },
      { name: "Důkazy_UTF-8.pdf", data: "y" },
    ];
    for (const nameCodePage of ["ibm437", "ibm852"] as const) {
      expect(
        (await listed(won, nameCodePage)).map(({ fileName }) => fileName),
      ).toEqual(["Procès-verbal_à_signer.pdf", "Důkazy_UTF-8.pdf"]);
    }
  });

  test("names the operating system adds for itself are not files", async () => {
    // A folder zipped in the macOS Finder, and one that held Windows
    // thumbnails and folder settings.
    const files = await read([
      {
        name: "Spis/",
        externalAttributes: unixExternalAttributes(UNIX_DIRECTORY),
      },
      { name: "Spis/Žaloba.pdf", data: "%PDF-1.7" },
      { name: "Spis/.DS_Store", data: "Bud1" },
      {
        name: "__MACOSX/",
        externalAttributes: unixExternalAttributes(UNIX_DIRECTORY),
      },
      { name: "__MACOSX/Spis/._Žaloba.pdf", data: "\u0000\u0005\u0016\u0007" },
      { name: "._Plná moc.pdf", data: "\u0000\u0005\u0016\u0007" },
      { name: "Plná moc.pdf", data: "%PDF-1.7" },
      { name: "Fotky/Thumbs.db", data: "thumbnails" },
      { name: "Fotky/DESKTOP.INI", data: "[.ShellClassInfo]" },
      { name: "Fotky/ohledání.jpg", data: "ÿØÿ" },
      // Names that only resemble them are files.
      { name: "Spis/DS_Store.txt", data: "poznámka" },
      { name: "MACOSX/zápis.txt", data: "zápis" },
    ]);
    expect(files.map(({ fileName, folder }) => ({ fileName, folder }))).toEqual(
      [
        { fileName: "Žaloba.pdf", folder: "Spis" },
        { fileName: "Plná moc.pdf", folder: null },
        { fileName: "ohledání.jpg", folder: "Fotky" },
        { fileName: "DS_Store.txt", folder: "Spis" },
        { fileName: "zápis.txt", folder: "MACOSX" },
      ],
    );
    // Parts are addressed by their place in this list, so the files after a
    // hidden entry still open as themselves.
    expect(
      files.map((file) => text(readZipArchiveFile(file).unwrap())),
    ).toEqual(["%PDF-1.7", "%PDF-1.7", "ÿØÿ", "poznámka", "zápis"]);
  });

  test("a name without the UTF-8 flag is UTF-8 when it decodes as such, else in a code page", async () => {
    // 0x82 is "é" and 0xA0 is "á" in code page 437; neither starts UTF-8.
    const cp437 = new Uint8Array([
      ...new TextEncoder().encode("vyj"),
      0xa0,
      ...new TextEncoder().encode("d"),
      0x82,
      ...new TextEncoder().encode("n.txt"),
    ]);
    const utf8 = new TextEncoder().encode("rozhodnutí.txt");
    expect(new TextDecoder("utf-8", { fatal: false }).decode(cp437)).toContain(
      "\uFFFD",
    );
    expect(
      await listed([
        { name: cp437, data: "Vyjádření žalovaného", flags: 0 },
        { name: utf8, data: "Rozhodnutí", flags: 0 },
        {
          name: new TextEncoder().encode("dukaz.txt"),
          data: "Důkaz",
          flags: 0,
          extra: unicodePathExtra(
            new TextEncoder().encode("dukaz.txt"),
            "důkaz č. 3.txt",
          ),
        },
        // A Unicode path field for another name is not this entry's.
        {
          name: new TextEncoder().encode("protokol.txt"),
          data: "Protokol",
          flags: 0,
          extra: unicodePathExtra(
            new TextEncoder().encode("jiny.txt"),
            "jiný.txt",
          ),
        },
      ]),
    ).toEqual([
      { fileName: "vyjádén.txt", folder: null, unavailable: null },
      { fileName: "rozhodnutí.txt", folder: null, unavailable: null },
      { fileName: "důkaz č. 3.txt", folder: null, unavailable: null },
      { fileName: "protokol.txt", folder: null, unavailable: null },
    ]);
  });

  test("a file under folders longer than a shown name stays a file", async () => {
    const folders = `${"a".repeat(255)}/`.repeat(4);
    const files = await read([
      { name: `${folders}smlouva.pdf`, data: "%PDF-1.7" },
      {
        name: folders,
        externalAttributes: unixExternalAttributes(UNIX_DIRECTORY),
      },
    ]);
    expect(files.map(({ fileName }) => fileName)).toEqual(["smlouva.pdf"]);
    // Cut at a shown name's bound, the whole name would end in a slash.
    expect(`${folders}smlouva.pdf`.slice(0, 1024).endsWith("/")).toBe(true);
    expect(files.at(0)?.folder).toBe(folders.slice(0, -1));
  });

  test("an archive of no files lists none", async () => {
    expect(await read([])).toEqual([]);
  });

  test("a control character in a name is never kept", async () => {
    const [file] = await read([
      { name: "faktura\u0007\u001b[31m.txt", data: "x" },
    ]);
    expect(file?.fileName).toBe("faktura\uFFFD\uFFFD[31m.txt");
  });

  test("a file that does not open is listed with the reason, the rest still open", async () => {
    const files = await read([
      { name: "heslo.pdf", data: "%PDF-1.7 secret", flags: 0x00_01 },
      { name: "silne.pdf", data: "%PDF-1.7 secret", flags: 0x00_40 },
      { name: "aes.pdf", data: "%PDF-1.7 secret", method: 99 },
      {
        name: "odkaz",
        data: "../../../etc/shadow",
        method: 0,
        externalAttributes: unixExternalAttributes(UNIX_SYMLINK),
      },
      { name: "bzip.txt", data: "BZh91AY&SY", method: 12 },
      { name: "kratky.txt", data: "Usnesení", method: 0, statedSize: 400 },
      { name: "poskozeny.txt", data: "Rozsudek", statedCrc32: 0x12_34_56_78 },
      { name: "citelny.txt", data: "Rozsudek ve věci 23 C 118/2026" },
    ]);
    expect(
      files.map(({ fileName, unavailable }) => [fileName, unavailable]),
    ).toEqual([
      ["heslo.pdf", "encrypted"],
      ["silne.pdf", "encrypted"],
      ["aes.pdf", "encrypted"],
      ["odkaz", "link"],
      ["bzip.txt", "unsupported"],
      ["kratky.txt", "unreadable"],
      ["poskozeny.txt", null],
      ["citelny.txt", null],
    ]);
    // A damaged file is found when it is read; it never opens.
    const opened = files.map((file) => readZipArchiveFile(file));
    expect(opened.map((result) => result.isOk())).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(opened.at(-1)?.map(text).unwrapOr(null)).toBe(
      "Rozsudek ve věci 23 C 118/2026",
    );
  });

  test("one file larger than a file may be is listed, not inflated", async () => {
    const large = new Uint8Array(ZIP_ARCHIVE_MAX_FILE_BYTES + 1);
    crypto.getRandomValues(large.subarray(0, 65_536));
    const [file] = await read([
      { name: "zaznam-jednani.wav", data: large, method: 0 },
    ]);
    expect(file?.unavailable).toBe("tooLarge");
    expect(file && readZipArchiveFile(file).isErr()).toBe(true);
  });

  test("an archive past the archive bounds is refused before anything inflates", async () => {
    const tooMany = makeZipArchive(
      Array.from({ length: 1001 }, (_, index) => ({
        name: `priloha-${String(index)}.txt`,
        data: "x",
        method: 0,
      })),
    );
    const bomb = makeZipArchive([
      { name: "bomba.txt", data: new Uint8Array(8 * 1024 * 1024) },
    ]);
    for (const bytes of [tooMany, bomb]) {
      const result = await readZipArchive(bytes, { nameCodePage: "ibm852" });
      expect(result.isErr() && result.error.reason).toBe("limit");
    }
    const notZip = await readZipArchive(new TextEncoder().encode("PK no"), {
      nameCodePage: "ibm437",
    });
    expect(notZip.isErr() && notZip.error.reason).toBe("invalid");
  });

  test("any archive of files reads back each file whole, under a shown name", async () => {
    const nameArbitrary = fc
      .array(fc.string({ minLength: 1, maxLength: 12 }), {
        minLength: 1,
        maxLength: 3,
      })
      .map((segments) => segments.join("/"))
      .filter((name) => !name.endsWith("/") && !name.endsWith("\\"))
      // A segment starting "." or "_" may name system metadata, never listed.
      .filter((name) => !/(?:^|[/\\])[._]/u.test(name));
    await assertProperty(
      "any archive of files reads back each file whole, under a shown name",
      fc.asyncProperty(
        fc.array(
          fc.record({
            name: nameArbitrary,
            data: fc.uint8Array({ maxLength: 256 }),
            method: fc.constantFrom(0, 8),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        async (entries) => {
          const files = await read(entries);
          expect(files).toHaveLength(entries.length);
          for (const [index, file] of files.entries()) {
            expect(file.fileName).not.toMatch(/\p{Cc}/u);
            expect(file.folder ?? "").not.toMatch(/\p{Cc}/u);
            expect(Array.from(readZipArchiveFile(file).unwrap())).toEqual(
              Array.from(entries[index]?.data ?? []),
            );
          }
        },
      ),
    );
  });
});

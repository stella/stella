/**
 * File names a ZIP archive stores without its UTF-8 flag, written as the
 * programs that make such archives write them:
 *
 * - Windows' compressed folders, 7-Zip and Total Commander in the OEM code
 *   page: 852 on Czech, Slovak, Polish and Hungarian Windows, 437 on English
 *   and Western European Windows;
 * - some archivers in the ANSI code page (windows-1250 or windows-1252);
 * - older Java tools and macOS `ditto` in UTF-8, without setting the flag.
 */
import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import { assertProperty, propertySeed } from "@stll/property-testing";

import { encodeText } from "./charsets.js";
import {
  decodeDosCodePage,
  type DosCodePage,
  encodeDosCodePage,
} from "./dos-code-pages.js";
import { UDHR_ARTICLE_1 } from "./udhr-article-1.fixture.js";
import { decodeUndeclaredFileNames } from "./undeclared-charset.js";

const inDosCodePage = (names: readonly string[], codePage: DosCodePage) =>
  names.map((name) => {
    const bytes = encodeDosCodePage(name, codePage);
    if (bytes === null) {
      throw new Error(`the fixture is writable in ${codePage}`);
    }
    return bytes;
  });

const inAnsiCodePage = (
  names: readonly string[],
  charset: "windows-1250" | "windows-1252",
) =>
  names.map((name) => {
    const bytes = encodeText(name, charset);
    if (bytes === null) {
      throw new Error(`the fixture is writable in ${charset}`);
    }
    return bytes;
  });

/** A Czech matter folder as an office zips it to send it on. */
const CZECH_NAMES = [
  "Smlouva_o_dílo_Kratochvíl.pdf",
  "Předávací_protokol.docx",
  "Přílohy/Výpis_z_účtu_březen.pdf",
  "Přílohy/Plná_moc_Šťastná.pdf",
  "Žaloba_o_zaplacení.docx",
];

describe("the DOS code pages", () => {
  test("map the letters Central and Western European names use", () => {
    // Bytes from the Unicode Consortium's CP852.TXT and CP437.TXT.
    expect(
      decodeDosCodePage(
        Uint8Array.of(0xfd, 0xd8, 0xa7, 0x9f, 0xe7, 0x85, 0x88, 0xa5, 0x8b),
        "ibm852",
      ),
    ).toBe("řěžčšůłąő");
    expect(
      decodeDosCodePage(Uint8Array.of(0x82, 0x85, 0x8a, 0x94, 0xe1), "ibm437"),
    ).toBe("éàèöß");
  });

  test("write back every byte they read", () => {
    for (const codePage of ["ibm437", "ibm852"] as const) {
      const every = Uint8Array.from({ length: 256 }, (_, byte) => byte);
      expect(
        encodeDosCodePage(decodeDosCodePage(every, codePage), codePage),
      ).toEqual(every);
    }
  });
});

describe("file names that declare no charset", () => {
  test("Czech names from Windows' compressed folders or 7-Zip read in code page 852", () => {
    expect(
      decodeUndeclaredFileNames(inDosCodePage(CZECH_NAMES, "ibm852")),
    ).toEqual({ names: CZECH_NAMES, charset: "ibm852" });
  });

  test("one name holding only a Czech letter 852 has and 437 does not", () => {
    expect(
      decodeUndeclaredFileNames(
        inDosCodePage(["Předávací_protokol.docx"], "ibm852"),
      ),
    ).toEqual({ names: ["Předávací_protokol.docx"], charset: "ibm852" });
  });

  test("Czech names from an archiver on the ANSI code page read in windows-1250", () => {
    expect(
      decodeUndeclaredFileNames(inAnsiCodePage(CZECH_NAMES, "windows-1250")),
    ).toEqual({ names: CZECH_NAMES, charset: "windows-1250" });
  });

  test("French and German names in code page 437 stay in 437", () => {
    const names = [
      "Procès-verbal_à_signer.pdf",
      "Übergabeprotokoll_Müller.pdf",
      "Contrat_de_bail_signé.pdf",
    ];
    expect(decodeUndeclaredFileNames(inDosCodePage(names, "ibm437"))).toEqual({
      names,
      charset: "ibm437",
    });
  });

  test("letters 437 and 852 write alike tie, and the tie goes to 437", () => {
    // á, í, é and ü have the same bytes in both: either reading is right.
    const names = ["Smlouva_o_dílo_Kratochvíl.pdf", "Vyjádření_Novák.pdf"];
    const bytes = inDosCodePage(names, "ibm852");
    expect(bytes.slice(0, 1)).toEqual(
      inDosCodePage(names.slice(0, 1), "ibm437"),
    );
    expect(decodeUndeclaredFileNames(bytes.slice(0, 1))).toEqual({
      names: names.slice(0, 1),
      charset: "ibm437",
    });
    // A letter only 852 has makes the same name read in 852.
    expect(decodeUndeclaredFileNames(bytes)).toEqual({
      names,
      charset: "ibm852",
    });
  });

  test("a name that is valid UTF-8 is UTF-8, beside names in a code page", () => {
    const utf8 = new TextEncoder().encode("Rozhodnutí_soudu.pdf");
    const [legacy] = inDosCodePage(["Předávací_protokol.docx"], "ibm852");
    expect(
      decodeUndeclaredFileNames([utf8, ...(legacy ? [legacy] : [])]),
    ).toEqual({
      names: ["Rozhodnutí_soudu.pdf", "Předávací_protokol.docx"],
      charset: "ibm852",
    });
    expect(decodeUndeclaredFileNames([utf8])).toEqual({
      names: ["Rozhodnutí_soudu.pdf"],
      charset: null,
    });
  });

  test("no names read as no names", () => {
    expect(decodeUndeclaredFileNames([])).toEqual({ names: [], charset: null });
  });

  test("a name whose one telling letter is ů, which 437 writes as à, ties and goes to 437", () => {
    // "Důkazy" in 852 is "Dàkazy" in 437: letters French, Italian and
    // Portuguese write, so no alphabet tells the two apart.
    expect(
      decodeUndeclaredFileNames(inDosCodePage(["Důkazy.pdf"], "ibm852")),
    ).toEqual({ names: ["Dàkazy.pdf"], charset: "ibm437" });
    // Any other Czech name in the archive settles it.
    expect(
      decodeUndeclaredFileNames(
        inDosCodePage(["Důkazy.pdf", "Předávací_protokol.docx"], "ibm852"),
      ).names,
    ).toEqual(["Důkazy.pdf", "Předávací_protokol.docx"]);
  });

  test("Czech, Slovak and Polish names in code page 852 read back, whichever words they hold", () => {
    // Letters whose 852 byte no scored language writes in 437 (ř is "²",
    // š "τ", ż "╛"); one of them in any name tells the code pages apart.
    const telling = /[řěčšťďňężńŘĚČŠŤĎŇĘŻŃ]/u;
    const words = (["cs", "sk", "pl"] as const).flatMap((language) =>
      UDHR_ARTICLE_1[language]
        .split(/[\s,.;:]+/u)
        .filter((word) => /[^\p{ASCII}]/u.test(word))
        .map((word) => ({ language, word })),
    );
    assertProperty(
      "names in code page 852 read back",
      fc.property(
        fc.constantFrom("cs", "sk", "pl").chain((language) =>
          fc
            .array(
              fc
                .array(
                  fc.constantFrom(
                    ...words
                      .filter((entry) => entry.language === language)
                      .map((entry) => entry.word),
                  ),
                  { minLength: 2, maxLength: 4 },
                )
                .map((parts) => `${parts.join("_")}.pdf`),
              { minLength: 2, maxLength: 6 },
            )
            .filter((names) => names.some((name) => telling.test(name))),
        ),
        (names) => {
          expect(
            decodeUndeclaredFileNames(inDosCodePage(names, "ibm852")).names,
          ).toEqual(names);
        },
      ),
      { numRuns: 200, seed: propertySeed() },
    );
  });
});

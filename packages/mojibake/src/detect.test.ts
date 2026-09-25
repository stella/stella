import { describe, expect, test } from "bun:test";

import { misdecode } from "./charsets.js";
import {
  checkTextEncoding,
  type EncodingFinding,
  repairMisdecoding,
} from "./detect.js";
import { UDHR_ARTICLE_1 } from "./udhr-article-1.fixture.js";

/**
 * The opening of Slovak Constitutional Court decision I. ÚS 66/98 as the
 * publisher serves it: written in windows-1250 and read as windows-1252
 * somewhere upstream, so "podľa" reads "pod¾a" and "čl." reads "èl.". The
 * "ť" of "neopodstatnenosť" is byte 0x9D, which windows-1252 leaves undefined,
 * and the publisher's text dropped it.
 */
const I_US_66_98 =
  "I. ÚS 66/98 Ústavný súd Slovenskej republiky v Košiciach na neverejnom zasadnutí senátu konanom 15. októbra 1998 predbežne prerokoval podnet O. Z., bytom B., vo veci porušenia jeho základného práva pod¾a èl. 46 ods. 1 Ústavy Slovenskej republiky a ¾udského práva pod¾a èl. 6 ods. 1 Dohovoru o ochrane ¾udských práv a základných slobôd postupom a rozhodnutiami Okresného súdu v Dolnom Kubíne v konaní sp. zn. 6 C 25/93 a Krajského súdu v Banskej Bystrici v konaní sp. zn. 16 Co 1281/94 a takto\n\nrozhodol:\n\nPodnet O. Z. na zaèatie konania odmieta pre jeho zjavnú neopodstatnenos.\n\nOdôvodnenie:\n\nI.\n\nÚstavnému súdu Slovenskej republiky (ïalej len „ústavný súd“) bolo\n\n8. septembra 1998 doruèené podanie O. Z. (ïalej len „navrhovate¾“), bytom B., oznaèené ako: „Podnet na zaèatie konania pred Ústavným súdom Slovenskej republiky pod¾a èlánku 130 ods. 3 Ústavy Slovenskej republiky“.";

const findingOf = <K extends EncodingFinding["kind"]>(
  text: string,
  language: string,
  kind: K,
): Extract<EncodingFinding, { kind: K }> | undefined => {
  const check = checkTextEncoding(text, language);
  if (check.status === "clean") {
    return undefined;
  }
  return check.findings.find(
    (finding): finding is Extract<EncodingFinding, { kind: K }> =>
      finding.kind === kind,
  );
};

describe("a decision the publisher serves mis-decoded", () => {
  test("names the pair and repairs every letter that survived", () => {
    const finding = findingOf(I_US_66_98, "sk", "misdecoded");
    expect(finding?.pair).toEqual({
      actual: "windows-1250",
      assumed: "windows-1252",
    });
    expect(finding?.layers).toBe(1);
    expect(finding?.damagedOccurrences).toBe(0);
    expect(finding?.samples.at(0)).toEqual({
      start: I_US_66_98.indexOf("pod¾a"),
      end: I_US_66_98.indexOf("pod¾a") + "pod¾a".length,
      text: "pod¾a",
      repaired: "podľa",
    });

    const repaired = repairMisdecoding(I_US_66_98, {
      language: "sk",
      pair: { actual: "windows-1250", assumed: "windows-1252" },
      layers: 1,
    });
    expect(repaired).toContain("základného práva podľa čl. 46 ods. 1");
    expect(repaired).toContain("(ďalej len „navrhovateľ“)");
    // Correct words and quotation marks are untouched.
    expect(repaired).toContain("Ústavný súd Slovenskej republiky v Košiciach");
    // The dropped byte stays dropped.
    expect(repaired).toContain("neopodstatnenos.");
  });
});

describe("signatures that need no alphabet", () => {
  test("replacement characters are reported where they stand", () => {
    const text = "Všichni lid� rod� se svobodní.";
    const finding = findingOf(text, "cs", "replacement-character");
    expect(finding?.occurrences).toBe(2);
    expect(finding?.samples.map(({ text: word }) => word)).toEqual([
      "lid�",
      "rod�",
    ]);
  });

  test("C1 controls are reported", () => {
    const text = `Všichni lidé${String.fromCodePoint(0x9a)} rodí se svobodní.`;
    expect(findingOf(text, "cs", "c1-control")?.occurrences).toBe(1);
  });

  test("UTF-8 read as windows-1252 is found for a language CLDR does not know", () => {
    const utf8 = misdecode(`${UDHR_ARTICLE_1.fr} ${UDHR_ARTICLE_1.fr}`, {
      actual: "utf-8",
      assumed: "windows-1252",
    });
    if (utf8 === null) {
      throw new Error("French is writable in UTF-8");
    }
    expect(
      findingOf(utf8, "zxx", "utf8-read-as-single-byte")?.samples.at(0),
    ).toEqual({
      start: utf8.indexOf("Ãªtres"),
      end: utf8.indexOf("Ãªtres") + "Ãªtres".length,
      text: "Ãªtres",
      repaired: "êtres",
    });
    expect(findingOf(utf8, "zxx", "misdecoded")).toBeUndefined();
  });
});

describe("double-encoded UTF-8", () => {
  test("is repaired through both layers", () => {
    const pair = { actual: "utf-8", assumed: "windows-1252" } as const;
    const text = `${UDHR_ARTICLE_1.cs}\n${UDHR_ARTICLE_1.cs}`;
    const once = misdecode(text, pair);
    const twice = once === null ? null : misdecode(once, pair);
    if (twice === null) {
      throw new Error("each layer is writable in UTF-8");
    }
    const finding = findingOf(twice, "cs", "misdecoded");
    expect(finding?.pair).toEqual(pair);
    expect(finding?.layers).toBe(2);
    expect(repairMisdecoding(twice, { language: "cs", pair, layers: 2 })).toBe(
      text,
    );
  });
});

describe("letters that only look native", () => {
  test("a capital inside a lowercase word is read as a mis-decoded byte", () => {
    // UTF-8 "é" read as ISO-8859-2 is "ĂŠ"; read back through windows-1250
    // instead it becomes "Ê", a French letter, but not one French writes
    // inside "dignité".
    const text = `${UDHR_ARTICLE_1.fr}\n${UDHR_ARTICLE_1.fr}`;
    const pair = { actual: "utf-8", assumed: "iso-8859-2" } as const;
    const misread = misdecode(text, pair);
    if (misread === null) {
      throw new Error("French is writable in UTF-8");
    }
    const finding = findingOf(misread, "fr", "misdecoded");
    expect(finding?.pair).toEqual(pair);
    expect(finding?.alternatives).toEqual([]);
    expect(
      repairMisdecoding(misread, { language: "fr", pair, layers: 1 }),
    ).toBe(text);
  });
});

describe("text that reads correctly", () => {
  // Characters that are also what mis-decoding produces, in the places a
  // writer puts them: a fraction or unit standing apart, a footnote mark, a
  // foreign name, the language's own ß or ø.
  const LEGITIMATE = [
    [
      "cs",
      `${UDHR_ARTICLE_1.cs} Žalobkyni náleží ¾ podílu, tj. 250 m ², viz poznámku ¹. Søren Kierkegaard, Straße, Łódź.`,
    ],
    [
      "sk",
      `${UDHR_ARTICLE_1.sk} Podiel ¾ a ½, výmera 12 m ², teplota 20 °C, § 3 ods. 1, ± 5 %.`,
    ],
    [
      "de",
      `${UDHR_ARTICLE_1.de} Die Straße, das Maß, ¼ des Anteils, Ø 5 mm, Brønshøj.`,
    ],
    ["pl", `${UDHR_ARTICLE_1.pl} Dvořák, Müller, ¾ udziału, 5 m ².`],
    ["fr", `${UDHR_ARTICLE_1.fr} « Œuvre » de Dvořák, ¹ note, 3 ½ ans.`],
  ] as const;

  test.each(LEGITIMATE)("%s is clean", (language, text) => {
    expect(checkTextEncoding(text, language)).toEqual({ status: "clean" });
  });

  test("a tag with a region or script resolves to its language", () => {
    const utf8 = misdecode(`${UDHR_ARTICLE_1.sk} ${UDHR_ARTICLE_1.sk}`, {
      actual: "windows-1250",
      assumed: "windows-1252",
    });
    if (utf8 === null) {
      throw new Error("Slovak is writable in windows-1250");
    }
    expect(findingOf(utf8, "sk-SK", "misdecoded")?.pair.actual).toBe(
      "windows-1250",
    );
    expect(checkTextEncoding(UDHR_ARTICLE_1.sk, "sk-SK")).toEqual({
      status: "clean",
    });
  });
});

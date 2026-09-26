import { describe, expect, test } from "bun:test";

import { misdecode } from "./charsets.js";
import {
  checkTextEncoding,
  CODE_UNIT_BUDGET,
  type EncodingCheckCounters,
  type EncodingFinding,
  MAX_EXAMINED_WORDS,
  MAX_WORD_CODE_UNITS,
  PAIR_EVALUATION_BUDGET,
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
  if (check.status !== "suspect") {
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

describe("UTF-8 punctuation read as windows-1252", () => {
  test("is found in text that is otherwise ASCII", () => {
    const text = "The courtâ€™s decision â€” an appeal â€“ is final.";
    const finding = findingOf(text, "en", "utf8-read-as-single-byte");
    expect(finding?.occurrences).toBe(3);
    expect(finding?.samples.map(({ repaired }) => repaired)).toEqual([
      "court’s",
      "—",
      "–",
    ]);
  });

  test("is found for quotation marks, ellipses and signs", () => {
    // ” is E2 80 9D, and windows-1252 leaves 9D undefined: WHATWG reads it
    // as the C1 control U+009D.
    const text =
      "â€œFinalâ€\u009d he said â€˜noâ€™, costs â‚¬5â€¦ per Â§ 3, 20Â°C.";
    expect(
      findingOf(text, "en", "utf8-read-as-single-byte")?.samples.map(
        ({ repaired }) => repaired,
      ),
    ).toEqual(["“Final”", "‘no’", "€5…", "§", "°C"]);
  });

  // A restored mark is its own signature: no lowercase word need vouch for
  // it, unlike a restored letter, which capitals spell by accident.
  test.each([
    ["cs", "Â§ 1, Â§ 2", "§"],
    ["en", "20Â°C 30Â°C", "°C"],
    ["de", "Â§Â§ 3 UND 4, Â§ 5", "§§"],
  ])("is found in %s %s, with no lowercase word", (language, text, first) => {
    expect(
      findingOf(text, language, "utf8-read-as-single-byte")?.samples.at(0)
        ?.repaired,
    ).toBe(first);
  });

  // "Â" is a letter French and Romanian write: before a footnote mark or a
  // nonbreaking space it is a capital with notation, not C2 read as
  // windows-1252, and the lowercase word the space binds to it is no proof
  // otherwise.
  test.each([
    ["fr", "La lettre Â¹ et la lettre Â² sont identiques."],
    ["ro", "Literele Â¹ și Â² sunt identice."],
    ["fr", "Les lettres Â  et Â  sont identiques."],
    ["fr", "La lettre Â\u00A0est une voyelle. La lettre Â\u00A0est majuscule."],
    ["ro", "Litera Â\u00A0este o vocală. Litera Â\u00A0este o vocală."],
  ])(
    "is not found in %s %s, where the lead is a native letter",
    (language, text) => {
      expect(checkTextEncoding(text, language)).toEqual({ status: "clean" });
    },
  );

  test("letters restored in capitals alone are no signature", () => {
    // Slovak "ÄŽ" is C4 8E: the UTF-8 bytes of "Ď".
    expect(checkTextEncoding("ÄŽ ÄŽ ÄŽ", "sk")).toEqual({ status: "clean" });
  });
});

describe("work on a long text of distinct words", () => {
  /** Latin letters spelling `index`, so every word is a distinct word. */
  const spelled = (index: number): string => {
    let rest = index;
    let word = "";
    do {
      word += String.fromCodePoint(0x61 + (rest % 26));
      rest = Math.floor(rest / 26);
    } while (rest > 0);
    return word;
  };
  const textOf = (bytes: number, word: (index: number) => string): string => {
    const words: string[] = [];
    let length = 0;
    for (let index = 0; length < bytes; index += 1) {
      const next = word(index);
      words.push(next);
      length += next.length + 1;
    }
    return words.join(" ");
  };
  const HALF_MEGABYTE = 500_000;
  // Never "clean": a check that stopped at a bound says so, unless what it
  // did weigh is already evidence. Thousands of distinct words in letters
  // Czech does not write, each one read back into Czech, are.
  const SHAPES = [
    ["foreign letters", (index: number) => `Sø${spelled(index)}`, "suspect"],
    ["native letters", (index: number) => `př${spelled(index)}`, "incomplete"],
    [
      "both",
      (index: number) =>
        index % 2 === 0 ? `Sø${spelled(index)}` : `př${spelled(index)}`,
      "incomplete",
    ],
  ] as const;

  test.each(SHAPES)(
    "half a megabyte, %s: within the documented bounds, and never called clean",
    (_, word, status) => {
      const text = textOf(HALF_MEGABYTE, word);
      const counters: EncodingCheckCounters = {
        wordsExamined: 0,
        pairEvaluations: 0,
        codeUnits: 0,
        scannedCodeUnits: 0,
      };
      const check = checkTextEncoding(text, "cs", { counters });
      expect(check.status).toBe(status);
      // A bounded check never weighs, or reads back, more than it documents.
      expect(counters.wordsExamined).toBeLessThanOrEqual(MAX_EXAMINED_WORDS);
      expect(counters.pairEvaluations).toBeLessThanOrEqual(
        PAIR_EVALUATION_BUDGET,
      );
      expect(counters.codeUnits).toBeLessThanOrEqual(CODE_UNIT_BUDGET);
    },
  );

  test("a word past the length bound is not weighed, and the check says so", () => {
    const counters: EncodingCheckCounters = {
      wordsExamined: 0,
      pairEvaluations: 0,
      codeUnits: 0,
      scannedCodeUnits: 0,
    };
    const check = checkTextEncoding(`Søren${"a".repeat(500_000)}`, "cs", {
      counters,
    });
    expect(check).toEqual({ status: "incomplete", limit: "long-words" });
    expect(counters.codeUnits).toBe(0);
  });

  test("words within the length bound are weighed up to the code-unit budget", () => {
    // Distinct native words, each just inside the length bound, that add up
    // to more characters than the check classifies.
    const length = MAX_WORD_CODE_UNITS;
    const count = Math.ceil((CODE_UNIT_BUDGET * 1.5) / length);
    const text = Array.from({ length: count }, (_, index) =>
      `př${spelled(index)}`.padEnd(length, "a"),
    ).join(" ");
    expect(count).toBeLessThan(MAX_EXAMINED_WORDS);
    const counters: EncodingCheckCounters = {
      wordsExamined: 0,
      pairEvaluations: 0,
      codeUnits: 0,
      scannedCodeUnits: 0,
    };
    expect(checkTextEncoding(text, "cs", { counters })).toEqual({
      status: "incomplete",
      limit: "code-units",
    });
    expect(counters.codeUnits).toBeLessThanOrEqual(CODE_UNIT_BUDGET);
  });

  test("counters describe the last check alone", () => {
    const counters: EncodingCheckCounters = {
      wordsExamined: 0,
      pairEvaluations: 0,
      codeUnits: 0,
      scannedCodeUnits: 0,
    };
    checkTextEncoding("pod¾a ¾udí, pod¾a ¾udí", "sk", { counters });
    expect(counters.pairEvaluations).toBeGreaterThan(0);
    expect(counters.codeUnits).toBeGreaterThan(0);
    const ascii = "plain ASCII";
    checkTextEncoding(ascii, "sk", { counters });
    // The scan reads a code unit at most three times: fewer than both
    // checks' texts together.
    expect(counters).toEqual({
      wordsExamined: 0,
      pairEvaluations: 0,
      codeUnits: 0,
      scannedCodeUnits: expect.any(Number),
    });
    expect(counters.scannedCodeUnits).toBeLessThanOrEqual(3 * ascii.length);
  });

  test("a decision-sized text is checked whole", () => {
    const text = textOf(20_000, (index) => `př${spelled(index % 300)}`);
    expect(checkTextEncoding(text, "cs")).toEqual({ status: "clean" });
  });
});

// Smoke checks in real time, far above linear cost and far below what
// rescanning a run from every position costs at these sizes (seconds). The
// linearity itself is asserted by operation count in the property suite.
describe("a long run of one character class finishes promptly", () => {
  const PROMPT_MS = 1000;
  const RUN = 30_000;

  test.each([
    ["before a final non-ASCII letter", `${".".repeat(RUN)}ø`, "clean"],
    ["inside a token", `a${".".repeat(RUN)}ø`, "incomplete"],
  ])("ASCII punctuation %s", (_, text, status) => {
    const started = performance.now();
    const check = checkTextEncoding(text, "cs");
    expect(performance.now() - started).toBeLessThan(PROMPT_MS);
    expect(check.status).toBe(status);
  });

  test("combining marks in a word too long to weigh are left as they are", () => {
    // Canonical reordering sorts a run of combining marks by insertion, so
    // normalizing this word costs seconds.
    const text = `a${"̖́".repeat(20_000)}`;
    const started = performance.now();
    const repaired = repairMisdecoding(text, {
      language: "cs",
      pair: { actual: "utf-8", assumed: "windows-1252" },
      layers: 1,
    });
    expect(performance.now() - started).toBeLessThan(PROMPT_MS);
    expect(repaired).toBe(text);
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
    // Ú Ž in windows-1252 are bytes DA 8E: valid UTF-8, for an Arabic letter.
    ["sk", `${UDHR_ARTICLE_1.sk} Rozhodnutie KÚŽP a stanovisko KÚŽP.`],
    // Í Š and Ý Š in windows-1252 are UTF-8 for combining marks.
    ["cs", `${UDHR_ARTICLE_1.cs} Žalobce POSPÍŠIL, zástupce POSPÍŠIL.`],
    ["sk", `${UDHR_ARTICLE_1.sk} VÝŠKA NÁHRADY, VÝŠKA ÚROKU.`],
  ] as const;

  // Short passages with no word of the language's own non-ASCII letters to
  // weigh against a pair: whatever they are judged on, it is not padding.
  const SHORT = [
    // One name, however it is punctuated, is one word.
    ["cs", "Søren Søren, Søren."],
    ["cs", "„Søren“ (Søren) Søren; Søren!"],
    // Units and footnote marks attached to the word they qualify.
    ["cs", "m² km² cm²"],
    ["cs", "m², km³ a cm². Výměra¹ a hodnota² viz poznámka³."],
    ["pl", "m¹ km¹ cm¹"],
    ["sk", "20°C, 5°F a 30°C."],
    // Two foreign names, several times: letters of another alphabet alone.
    ["cs", "Søren Brønshøj, Søren a Brønshøj."],
    ["pl", "Müller Dvořák Müller Dvořák"],
  ] as const;

  test.each(SHORT)("%s %s is clean", (language, text) => {
    expect(checkTextEncoding(text, language)).toEqual({ status: "clean" });
  });

  test("a short mis-decoded passage is still reported, and never with certainty", () => {
    // Slovak "ľ" read as windows-1252 is "¾" inside a word: that is no
    // letter of any alphabet, so it is found without native words around it.
    const finding = findingOf("pod¾a ¾udí, pod¾a ¾udí", "sk", "misdecoded");
    expect(finding?.pair.actual).toBe("windows-1250");
    expect(finding?.confidence).toBeLessThan(1);
  });

  test("Latin words in a Cyrillic text are not read back into Cyrillic", () => {
    // A court's language menu, printed into every language version: each
    // language's name in its own letters, which windows-1251 read as
    // windows-1257 would turn into Bulgarian-looking "Latvieрu".
    const menu = "lvLatviešu ltLietuvių skSlovenčina plPolski huMagyar";
    // A page stored in place of the decision carries no Bulgarian word for
    // the pair to break, so only the mixed script tells.
    const text = [menu, menu, menu].join("\n");
    expect(checkTextEncoding(text, "bg")).toEqual({ status: "clean" });
  });

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

describe("short mis-decoded text in letters alone", () => {
  // What the foreign-word threshold (`MIN_FOREIGN_WORDS`) costs on short
  // text: damage in letters alone reads as foreign names until a third
  // distinct word shows it. Moving the threshold moves a row here.
  const SHORT_MISDECODED = [
    // "øízení" and "naøízení": two words, three occurrences.
    ["řízení podle nařízení; toto řízení se zastavuje.", 2, "clean"],
    // "øízení", "pøerušuje", "skonèení".
    ["řízení se přerušuje do skončení řízení", 3, "suspect"],
  ] as const;

  test.each(SHORT_MISDECODED)(
    "cs %s read as windows-1252, %d distinct words damaged, is %s",
    (written, damaged, status) => {
      const misread = misdecode(written, {
        actual: "windows-1250",
        assumed: "windows-1252",
      });
      if (misread === null) {
        throw new Error("Czech is writable in windows-1250");
      }
      const originals = written.split(/\s+/u);
      const changed = misread
        .split(/\s+/u)
        .filter((word, index) => word !== originals[index])
        .map((word) => word.replaceAll(/[^\p{L}]/gu, ""));
      expect(new Set(changed).size).toBe(damaged);
      expect(checkTextEncoding(misread, "cs").status).toBe(status);
    },
  );
});

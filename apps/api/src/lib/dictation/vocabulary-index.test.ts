import { describe, expect, test } from "bun:test";

import {
  alignmentDistance,
  buildVocabularyIndex,
  oneEditApart,
  selectVocabulary,
} from "./vocabulary-index";

const select = (words: readonly string[], transcript: string, limit = 10) =>
  selectVocabulary(buildVocabularyIndex(words), transcript, limit);

describe("which organization words a transcript needs", () => {
  test("a word said outright is picked whatever its case or diacritics", () => {
    expect(
      select(["žaloba", "Novák", "Deloitte"], "podal ZALOBA proti panu novak"),
    ).toEqual(["žaloba", "Novák"]);
  });

  test("a word recognition split or joined still matches", () => {
    expect(
      new Set(
        select(["Facebook", "Hogan Lovells"], "face book a hoganlovells"),
      ),
    ).toEqual(new Set(["Facebook", "Hogan Lovells"]));
  });

  test("an English word written the way Czech sounds it matches", () => {
    expect(
      select(
        [
          "Microsoft",
          "Facebook",
          "Hogan Lovells",
          "due diligence",
          "Google Ireland",
        ],
        "poslal jsem to Majkrosoftu, Fejsbuk to ví, Hogan Lavels dělá dů dilidžens",
      ),
    ).toEqual(["Hogan Lovells", "Microsoft", "due diligence", "Facebook"]);
  });

  test("a word mentioned nowhere stays out, and so do short sound-alikes", () => {
    expect(select(["NDA", "Deloitte", "Kirkland"], "and then the end")).toEqual(
      [],
    );
  });

  test("better matches come first, and the limit holds", () => {
    const words = ["Novák", "Nováková", "Microsoft"];
    expect(select(words, "Novák a Majkrosoft", 1)).toEqual(["Novák"]);
    expect(select(words, "Novák a Majkrosoft", 2)).toEqual([
      "Novák",
      "Microsoft",
    ]);
  });

  test("ties go to the newest word", () => {
    expect(select(["Novak", "Novák"], "novak")).toEqual(["Novak", "Novák"]);
    expect(select(["Novák", "Novak"], "novak")).toEqual(["Novák", "Novak"]);
  });

  test("one occurrence counts once, however many lookups reach it", () => {
    // Both are said once and match exactly; `chance` has more skeleton
    // readings than `Novak`, which must not make it look said more often.
    expect(select(["Novak", "chance"], "novak chance", 1)).toEqual(["Novak"]);
  });

  test("a word said again still outranks a word said once", () => {
    expect(select(["Novak", "chance"], "chance novak chance", 1)).toEqual([
      "chance",
    ]);
  });

  test("an empty list or limit picks nothing", () => {
    expect(select([], "Novák")).toEqual([]);
    expect(select(["Novák"], "Novák", 0)).toEqual([]);
  });
});

describe("edit distance", () => {
  test("counts a swap of neighbours as one edit", () => {
    expect(alignmentDistance("abcd", "abdc")).toBe(1);
    expect(alignmentDistance("kitten", "sitting")).toBe(3);
    expect(alignmentDistance("", "abc")).toBe(3);
    for (const [left, right] of [
      ["MKRSFT", "MKRSFT"],
      ["MKRSFT", "MKRSF"],
      ["MKRSFT", "MKRSST"],
      ["MKRSFT", "MKRFST"],
      ["MKRSFT", "KMRSTF"],
      ["MKRSFT", "XMKRSFT"],
    ] as const) {
      expect(oneEditApart(left, right)).toBe(
        alignmentDistance(left, right) === 1,
      );
    }
  });
});

/** A seeded pseudo-random source, so the data is the same on every run. */
const seeded = (seed: number) => {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
};

describe("at the scale of a full list", () => {
  test("ten thousand words index and serve a long transcript in bounded time", () => {
    const random = seeded(11);
    const pick = <T>(items: readonly T[]): T => {
      const item = items[Math.floor(random() * items.length)];
      if (item === undefined) {
        throw new TypeError("Expected an item");
      }
      return item;
    };
    const consonants = Array.from("bcdfghjklmnprstvzšžčřň");
    const vowels = Array.from("aeiouyáéíůě");
    const name = () => {
      let word = pick(consonants).toUpperCase();
      const syllables = 2 + Math.floor(random() * 4);
      for (let index = 0; index < syllables; index += 1) {
        word += pick(vowels) + pick(consonants);
      }
      return word;
    };
    const words = Array.from({ length: 10_000 }, (_, index) => {
      if (index % 9 === 0) {
        return `${name()} ${name()} ${name()}`;
      }
      return index % 4 === 0 ? `${name()} ${name()}` : name();
    });
    const common =
      "a se na že to je v do s by o pro jak ale jsem byl když už jen tak také nebo podle smlouvy strany soud žaloba rozsudek odvolání klient návrh lhůta den měsíc rok paragraf odstavec zákon občanský zákoník advokát kupní nájemní platba faktura dlužník věřitel insolvence řízení the and of to in that is for it with as on be by this court contract party agreement".split(
        " ",
      );
    const mentioned = words.slice(0, 40);
    const spoken: string[] = [];
    while (spoken.join(" ").length < 12_000) {
      spoken.push(random() < 0.01 ? pick(mentioned) : pick(common));
    }
    const transcript = spoken.join(" ");

    const index = buildVocabularyIndex(words);
    const work = { visited: 0, compared: 0 };
    const selected = selectVocabulary(index, transcript, 150, work);

    // Every word said outright is among those picked.
    for (const word of mentioned.filter((term) => transcript.includes(term))) {
      expect(selected).toContain(word);
    }
    expect(selected.length).toBeLessThanOrEqual(150);
    // Lookups are by key, so the work is a few list entries per spoken
    // word (about 11 visited and 4 compared here), where comparing every
    // run of words with every list word would take tens of millions.
    // Measured on a loaded laptop: about 0.2 s to build, 0.1 s to select.
    expect(work.compared).toBeLessThan(spoken.length * 8);
    expect(work.visited).toBeLessThan(spoken.length * 20);
  });
});

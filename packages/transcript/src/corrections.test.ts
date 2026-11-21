import { describe, expect, test } from "bun:test";

import {
  applyLearnedFixes,
  editsOf,
  LEARNED_FIX_LIMIT,
  learnFrom,
} from "./corrections";
import type { DictatedSpan, LearnedFix } from "./corrections";

/** A field holding `before`, then the dictated `dictated`, then `after`. */
const span = (before: string, dictated: string, after = ""): DictatedSpan => ({
  text: `${before}${dictated}${after}`,
  start: before.length,
  end: before.length + dictated.length,
});

const fix = (
  from: string,
  to: string,
  status: LearnedFix["status"] = "on",
  seen = 2,
): LearnedFix => ({ from, to, seen, status });

describe("what the person fixed", () => {
  test("a replaced word is a correction", () => {
    expect(
      editsOf(
        span("", "Pošli to panu Novakovi zítra."),
        "Pošli to panu Novákovi zítra.",
      ).corrections,
    ).toEqual([{ from: "Novakovi", to: "Novákovi" }]);
  });

  test("a short phrase is a correction", () => {
    expect(
      editsOf(
        span("", "Smlouvu připraví Baker Mc Kenzie do pátku."),
        "Smlouvu připraví Baker McKenzie do pátku.",
      ).corrections,
    ).toEqual([{ from: "Mc Kenzie", to: "McKenzie" }]);
  });

  test("the capital of a sentence start is not part of the spelling", () => {
    expect(
      editsOf(span("Hotovo. ", "Kubernetis běží."), "Hotovo. Kubernetes běží.")
        .corrections,
    ).toEqual([{ from: "kubernetis", to: "kubernetes" }]);
  });

  test("text typed around the dictation teaches nothing", () => {
    expect(
      editsOf(
        span("Ahoj, ", "pošlu smlouvu zítra.", " Díky"),
        "Dobrý den, pošlu smlouvu zítra. Děkuji",
      ),
    ).toEqual({ corrections: [], kept: [] });
  });

  test("other words, a negation and digits are no spelling fixes", () => {
    const changed = (dictated: string, final: string) =>
      editsOf(span("", dictated), final).corrections;
    expect(
      changed("Klient souhlasí s návrhem.", "Klient nesouhlasí s návrhem."),
    ).toEqual([]);
    expect(
      changed("Termín je v pondělí ráno.", "Termín je v úterý ráno."),
    ).toEqual([]);
    expect(
      changed("Podle normy ISO 27001 platí.", "Podle normy ISO 27002 platí."),
    ).toEqual([]);
    expect(changed("Jde to a pak dál.", "Jde to o pak dál.")).toEqual([]);
  });

  test("a rewrite teaches nothing", () => {
    expect(
      editsOf(span("", "Pošli to zítra."), "Zavolám mu radši hned.")
        .corrections,
    ).toEqual([]);
  });

  test("words kept in an edited dictation are reported, in an untouched one not", () => {
    expect(
      editsOf(
        span("", "Stela poslala smlouvu Novakovi."),
        "Stela poslala smlouvu Novákovi.",
      ).kept,
    ).toEqual([["Stela", "poslala", "smlouvu"]]);
    expect(
      editsOf(span("", "Stela poslala smlouvu."), "Stela poslala smlouvu.")
        .kept,
    ).toEqual([]);
  });

  test("a capital inside a word is a fix, a capital at the start alone is not", () => {
    expect(
      editsOf(
        span("", "Volal pan Mckenzie včera."),
        "Volal pan McKenzie včera.",
      ).corrections,
    ).toEqual([{ from: "Mckenzie", to: "McKenzie" }]);
    expect(
      editsOf(span("", "Volala dana včera."), "Volala Dana včera.").corrections,
    ).toEqual([]);
  });
});

describe("learning a fix", () => {
  const corrected = {
    corrections: [{ from: "stela", to: "stella" }],
    kept: [],
  };

  test("a correction seen twice is applied", () => {
    const once = learnFrom([], corrected);
    expect(once).toEqual([fix("stela", "stella", "learning", 1)]);
    expect(learnFrom(once, corrected)).toEqual([
      fix("stela", "stella", "on", 2),
    ]);
  });

  test("a correction made another way is never applied", () => {
    const once = learnFrom([], corrected);
    const other = learnFrom(once, {
      corrections: [{ from: "stela", to: "stela's" }],
      kept: [],
    });
    expect(learnFrom(other, corrected).at(0)?.status).toBe("contradicted");
  });

  test("words kept as dictated contradict the fix", () => {
    const learned = learnFrom([fix("stela", "stella", "learning", 1)], {
      corrections: [{ from: "Novakovi", to: "Novákovi" }],
      kept: [["stela", "poslala"]],
    });
    expect(learned.find(({ from }) => from === "stela")?.status).toBe(
      "contradicted",
    );
  });

  test("a fix turned back is contradicted, one switched off stays off", () => {
    const back = { corrections: [{ from: "stella", to: "stela" }], kept: [] };
    expect(learnFrom([fix("stela", "stella")], back).at(0)?.status).toBe(
      "contradicted",
    );
    expect(learnFrom([fix("stela", "stella", "off")], back).at(0)?.status).toBe(
      "off",
    );
  });

  test("past the limit the oldest unused fix goes first", () => {
    const many = Array.from({ length: LEARNED_FIX_LIMIT }, (_, index) =>
      fix(
        `slovo${String(index)}`,
        `slovoo${String(index)}`,
        index === 1 ? "learning" : "on",
      ),
    );
    const learned = learnFrom(many, corrected);
    expect(learned).toHaveLength(LEARNED_FIX_LIMIT);
    expect(learned.some(({ from }) => from === "slovo1")).toBe(false);
    expect(learned.at(-1)?.from).toBe("stela");
  });
});

describe("learning a fix of case or of a repeated word", () => {
  test("a fix of the case inside a word is learned, not taken for a reversal", () => {
    const corrected = {
      corrections: [{ from: "Mckenzie", to: "McKenzie" }],
      kept: [],
    };
    const twice = learnFrom(learnFrom([], corrected), corrected);
    expect(twice.at(0)?.status).toBe("on");
  });

  test("the right spelling kept elsewhere does not contradict a case fix", () => {
    const learned = learnFrom([fix("Mckenzie", "McKenzie", "learning", 1)], {
      corrections: [{ from: "Novakovi", to: "Novákovi" }],
      kept: [["pan", "McKenzie", "volal"]],
    });
    expect(learned.at(0)?.status).toBe("learning");
  });

  test("one dictation corrected twice the same way is one sighting", () => {
    const edits = editsOf(
      span("", "Stela volala a stela psala dlouho večer."),
      "Stella volala a stella psala dlouho večer.",
    );
    expect(edits.corrections).toHaveLength(2);
    expect(learnFrom([], edits).at(0)?.status).toBe("learning");
  });

  test("words put in between dictated words part their kept run", () => {
    const edits = editsOf(
      span("", "Mc Kenzie volal dnes ráno Novakovi."),
      "Mc John Kenzie volal dnes ráno Novákovi.",
    );
    expect(edits.kept).toEqual([["Mc"], ["Kenzie", "volal", "dnes", "ráno"]]);
  });
});

describe("applying what was learned", () => {
  test("a fix that is on spells its words, cased as they stood", () => {
    expect(
      applyLearnedFixes("Stela volala. Pak stela psala.", [
        fix("stela", "stella"),
      ]),
    ).toBe("Stella volala. Pak stella psala.");
  });

  test("a phrase matches word for word, whole words only", () => {
    expect(
      applyLearnedFixes("Volal Baker Mc Kenzie a Stelana.", [
        fix("Baker Mc Kenzie", "Baker McKenzie"),
        fix("stela", "stella"),
      ]),
    ).toBe("Volal Baker McKenzie a Stelana.");
  });

  test("fixes still learning, off or contradicted change nothing", () => {
    const text = "stela volala";
    for (const status of ["learning", "off", "contradicted"] as const) {
      expect(applyLearnedFixes(text, [fix("stela", "stella", status)])).toBe(
        text,
      );
    }
  });
});

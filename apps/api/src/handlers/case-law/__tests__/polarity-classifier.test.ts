import { describe, expect, test } from "bun:test";

import {
  CLASSIFIABLE_POLARITIES,
  isValidPolarity,
  phraseToPattern,
  POLARITIES,
  POLARITY,
  POLARITY_PRECEDENCE,
} from "@/api/handlers/case-law/polarity/consts";
import type { Polarity } from "@/api/handlers/case-law/polarity/consts";
import { extractContext } from "@/api/handlers/case-law/polarity/context";
import {
  compileRules,
  selectRuleMatch,
} from "@/api/handlers/case-law/polarity/rule-engine";
import {
  RETIRED_SEED_RULES,
  SEED_RULES,
} from "@/api/handlers/case-law/polarity/seed-rules";
import { createSafeId } from "@/api/lib/branded-types";

describe("extractContext", () => {
  const sections = [
    { text: "Header text about the case." },
    {
      text:
        "The court held that in accordance with sp. zn. 21 Cdo 1234/2020, " +
        "the previous ruling was correct. The defendant's arguments were " +
        "rejected as unfounded.",
    },
    { text: "The ruling is final." },
  ];

  test("extracts context around citation in specific section", () => {
    const ctx = extractContext(sections, "sp. zn. 21 Cdo 1234/2020", 1);
    expect(ctx).toContain("sp. zn. 21 Cdo 1234/2020");
    expect(ctx).toContain("in accordance with");
  });

  test("searches all sections when sectionIndex is null", () => {
    const ctx = extractContext(sections, "sp. zn. 21 Cdo 1234/2020", null);
    expect(ctx).toContain("sp. zn. 21 Cdo 1234/2020");
  });

  test("returns null when citation not found", () => {
    const ctx = extractContext(sections, "nonexistent citation", 0);
    expect(ctx).toBeNull();
  });
});

describe("phraseToPattern", () => {
  test("escapes special regex characters", () => {
    const pattern = phraseToPattern("srov.");
    expect(pattern).toBe("srov\\.");
  });

  test("replaces whitespace with flexible pattern", () => {
    const pattern = phraseToPattern("v souladu s");
    expect(pattern).toBe("v\\s+souladu\\s+s");
  });

  test("handles multiple spaces", () => {
    const pattern = phraseToPattern("k  tomu  blíže");
    expect(pattern).toBe("k\\s+tomu\\s+blíže");
  });
});

describe("isValidPolarity", () => {
  test("accepts a representative polarity", () => {
    expect(isValidPolarity("positive")).toBe(true);
  });

  test("rejects invalid values", () => {
    expect(isValidPolarity("maybe")).toBe(false);
    expect(isValidPolarity("")).toBe(false);
  });
});

describe("seed rules", () => {
  test("all rules have valid polarity", () => {
    for (const rule of SEED_RULES) {
      expect(isValidPolarity(rule.polarity)).toBe(true);
    }
  });

  test("all rules compile as valid regex", () => {
    for (const rule of SEED_RULES) {
      expect(() => new RegExp(rule.pattern, "iu")).not.toThrow();
    }
  });

  test("Czech positive rules match expected phrases", () => {
    const positiveRules = SEED_RULES.filter(
      (r) => r.language === "cs" && r.polarity === "positive",
    );

    const testCases = [
      "v souladu s nálezem Ústavního soudu",
      "odkazuje na rozhodnutí",
      "jak konstatoval Nejvyšší soud",
    ];

    for (const text of testCases) {
      const matched = positiveRules.some((r) =>
        new RegExp(r.pattern, "iu").test(text),
      );
      expect(matched).toBe(true);
    }
  });

  test("Czech negative rules match expected phrases", () => {
    const negativeRules = SEED_RULES.filter(
      (r) => r.language === "cs" && r.polarity === "negative",
    );

    const testCases = [
      "na rozdíl od předchozího rozhodnutí",
      "tento závěr byl překonán",
      "bez dalšího nelze aplikovat ani dovolatelkou zmiňovaný rozsudek Nejvyššího soudu",
      "v této věci nelze aplikovat závěry vyplývající z rozsudků",
      "na daný případ nelze aplikovat rozsudek Nejvyššího soudu",
      "tento rozsudek však nelze aplikovat",
      "závěry citovaného usnesení nelze aplikovat na projednávanou věc",
    ];

    for (const text of testCases) {
      const matched = negativeRules.some((r) =>
        new RegExp(r.pattern, "iu").test(text),
      );
      expect(matched).toBe(true);
    }
  });

  /**
   * Windows from the corpus in which a negative cue speaks of a party, a
   * court or a statute, next to a citation the court relies on. A negative
   * rule that fires on any of these labels an authority as overruled; the
   * class of defect is a cue without the cited decision as its object.
   */
  test("Czech negative rules stay silent where the cue is not about the cited decision", () => {
    const negativeRules = SEED_RULES.filter(
      (r) => r.language === "cs" && r.polarity === "negative",
    );

    const windows = [
      "Takovým postupem by přestal být nestranným rozhodčím sporu (viz např. rozsudek rozšířeného senátu Nejvyššího správního soudu ze dne 24. 8. 2010, č. j. 4 As 3/2008 – 78). Zcela obecné žalobní body tedy soud vypořádává se stejnou mírou obecnosti.",
      "V tomto směru podle názoru krajského soudu neobstojí odvolací námitka nedoručení výměru odůvodněná tvrzením, že povinná v jiné věci (sp. zn. 26 E 1519/1997) předložila generální plnou moc.",
      "Rovněž tak neobstojí jiné vyjádření, které ukazuje na značnou nejistotu souvislosti chybného postupu s nastalým stavem.",
      "Neobstojí ani případná argumentace, že se jednalo o vyjádření svobodné vůle účastníků s důsledky pacta sunt servanda.",
      "Pouhá paragrafová či slovní citace některého zákonného ustanovení jako stížní bod neobstojí.",
      "neboť ten, kdo odebíral plyn, na rozdíl od povinného, neměl uzavřenou žádnou smlouvu o odběru.",
      "nemá důvodu pochybovat o pravdivosti jeho tvrzení, neboť na rozdíl od stěžovatele nemá na výsledku řízení zájem.",
      "odvolací soud (na rozdíl od soudu prvního stupně) neuzavřel, že by nárok byl promlčen.",
      "Leasingovým společnostem, byť jsou vlastníky předmětu leasingu, na rozdíl od nájemního vztahu nezáleží na tom, zda leasingoví nájemci zhodnocují předmět leasingu.",
      "postup k odstranění pochybností nelze na rozdíl od daňové kontroly použít pro namátkové prošetření tvrzení daňového subjektu.",
      "Rozhodnutí odvolacího soudu o tom, že na posuzovanou věc nelze aplikovat § 1765 odst. 1 o. z., spočívá na závěrech, podle nichž závazek zanikl.",
      "nález Ústavního soudu vydaný v listopadu 2008 nelze aplikovat na daňovou kontrolu zahájenou v březnu téhož roku.",
      "Ustanovení § 1765 o. z. nelze aplikovat na daný případ (srov. rozsudek Nejvyššího soudu ze dne 11. 4. 2018, sp. zn. 31 Cdo 927/2016).",
      "Na rozdíl od situace v projednávané věci šlo o jednostranný zápočet; k tomu srov. rozsudek Nejvyššího soudu sp. zn. 31 Cdo 927/2016.",
      "Na rozdíl od krajského soudu, jehož rozsudek ze dne 3. 5. 2019 vycházel z jiného skutkového stavu, Nejvyšší soud dospěl k závěru, že žaloba je důvodná.",
      "Rozsudek uvádí, že § 1765 nelze aplikovat na závazky vzniklé před účinností zákona (srov. usnesení Nejvyššího soudu sp. zn. 29 Cdo 2303/2013).",
    ];

    for (const text of windows) {
      const fired = negativeRules.filter((r) =>
        new RegExp(r.pattern, "iu").test(text),
      );
      expect({ text, fired: fired.map((r) => r.pattern) }).toEqual({
        text,
        fired: [],
      });
    }
  });

  /**
   * A positive cue and a negative one in one window, the negative about the
   * cited decision: negative wins precedence, so the negative rule has to
   * fire or the retired cue's loss turns an inapplicable citation positive.
   */
  test("a decision named before the negative cue is still read as negative", () => {
    const rules = compileRules(
      SEED_RULES.filter((r) => r.language === "cs").map((r) => ({
        id: createSafeId<"caseLawPolarityRule">(),
        pattern: r.pattern,
        polarity: r.polarity,
        confidence: 1,
      })),
    );
    const context =
      "Dovolatel odkazuje na rozsudek Nejvyššího soudu ze dne 25. 11. 2008, sp. zn. 22 Cdo 3554/2008; tento rozsudek však nelze aplikovat, neboť vychází z jiných skutkových okolností.";
    expect(selectRuleMatch(rules, context)?.polarity).toBe(POLARITY.NEGATIVE);
  });

  test("Czech supportive rules match expected phrases", () => {
    const supportiveRules = SEED_RULES.filter(
      (r) => r.language === "cs" && r.polarity === "supportive",
    );

    const testCases = [
      "srov. rozhodnutí",
      "viz nález",
      "srovnej usnesení",
      "Nejvyšší soud judikoval",
      "lze odkázat na precedenční",
      "má oporu v rozhodovací činnosti",
      "přiléhavě odkázal na usnesení",
      "v judikatuře Nejvyššího soudu",
    ];

    for (const text of testCases) {
      const matched = supportiveRules.some((r) =>
        new RegExp(r.pattern, "iu").test(text),
      );
      expect(matched).toBe(true);
    }
  });

  test("Czech neutral rules match procedural phrases", () => {
    const neutralRules = SEED_RULES.filter(
      (r) => r.language === "cs" && r.polarity === "neutral",
    );

    const testCases = [
      "proti rozsudku Krajského soudu",
      "proti usnesení Nejvyššího soudu",
      "vedené u Okresního soudu",
      "vedeno pod sp. zn.",
    ];

    for (const text of testCases) {
      const matched = neutralRules.some((r) =>
        new RegExp(r.pattern, "iu").test(text),
      );
      expect(matched).toBe(true);
    }
  });

  test("a retired rule is not also seeded", () => {
    const seeded = new Set(SEED_RULES.map((r) => `${r.language}:${r.pattern}`));
    for (const retired of RETIRED_SEED_RULES) {
      expect(seeded.has(`${retired.language}:${retired.pattern}`)).toBe(false);
    }
  });

  test("rules are partitioned by language", () => {
    const languages = [...new Set(SEED_RULES.map((r) => r.language))];
    expect(languages).toContain("cs");
    expect(languages).toContain("sk");
  });
});

describe("the classifier codomain is one list", () => {
  test("every polarity but the pipeline's own is classifiable", () => {
    expect([...CLASSIFIABLE_POLARITIES]).toEqual(
      POLARITIES.filter((polarity) => polarity !== POLARITY.UNKNOWN),
    );
  });

  test("`unknown` is not something a classifier may emit", () => {
    // It records that classification did not happen. A model returning it
    // would be claiming the pipeline failed, which is not its to say.
    expect([...CLASSIFIABLE_POLARITIES]).not.toContain(POLARITY.UNKNOWN);
  });

  test("both tiers label with the same set", () => {
    // The drift this pins: the rule table has always emitted `supportive`
    // (`srov.`, `viz`, `obdobně`), while the LLM schema offered only
    // positive/neutral/negative, so the same phrase was labelled one way by
    // a regex rule and another by the model. Declared set equals exercised
    // set, in both directions.
    const seeded = new Set<Polarity>(SEED_RULES.map((rule) => rule.polarity));

    expect([...seeded].toSorted()).toEqual(
      [...CLASSIFIABLE_POLARITIES].toSorted(),
    );
  });

  test("precedence covers every polarity", () => {
    expect(Object.keys(POLARITY_PRECEDENCE).toSorted()).toEqual(
      [...POLARITIES].toSorted(),
    );
  });
});

describe("rule precedence", () => {
  const rule = ({
    pattern,
    polarity,
  }: {
    pattern: string;
    polarity: Polarity;
  }) => ({
    id: createSafeId<"caseLawPolarityRule">(),
    pattern,
    polarity,
    confidence: 1,
  });

  test("a quashed judgment under review does not turn a compare-cue negative", () => {
    // The sentence reports what happened to the order below and points at
    // authority for it. The withdrawn "byl zrušen" cue read the first half
    // as the fate of the authority.
    const context =
      "Není totiž povolán rušit to, co již bylo zrušeno či změněno " +
      "(srov. např. usnesení sp. zn. IV. ÚS 138/25).";
    const rules = compileRules(
      SEED_RULES.filter((r) => r.language === "cs").map((r) => rule(r)),
    );
    const retired = compileRules(
      RETIRED_SEED_RULES.filter((r) => r.language === "cs").map((r) =>
        rule({ pattern: r.pattern, polarity: POLARITY.NEGATIVE }),
      ),
    );

    expect(selectRuleMatch(retired, context)?.polarity).toBe(POLARITY.NEGATIVE);
    expect(selectRuleMatch(rules, context)?.polarity).toBe(POLARITY.SUPPORTIVE);
  });

  test("a rare specific negative rule beats a popular generic positive one", () => {
    // The rows are listed the way the old `ORDER BY match_count DESC` query
    // returned them: the busy generic rule first. It used to win by arriving
    // first, and every win raised its count further, so a negative rule that
    // fired rarely could never overtake it. Nothing in the engine reads
    // `match_count` any more, which is why this input cannot even express
    // "popular" and the negative rule wins on severity alone.
    const rules = compileRules([
      rule({ pattern: "odkazuje\\s+na", polarity: POLARITY.POSITIVE }),
      rule({ pattern: "na\\s+rozdíl\\s+od", polarity: POLARITY.NEGATIVE }),
    ]);

    const match = selectRuleMatch(
      rules,
      "Na rozdíl od věci sp. zn. 21 Cdo 1234/2020, na kterou žalobce " +
        "odkazuje na podporu svého názoru, jde zde o jiný skutkový základ.",
    );

    expect(match?.polarity).toBe(POLARITY.NEGATIVE);
  });

  test("supportive does not outrank negative either", () => {
    const rules = compileRules([
      rule({ pattern: "srov\\.", polarity: POLARITY.SUPPORTIVE }),
      rule({ pattern: "překonán[aouy]?", polarity: POLARITY.NEGATIVE }),
    ]);

    const match = selectRuleMatch(
      rules,
      "Tento závěr byl překonán; srov. rozsudek velkého senátu.",
    );

    expect(match?.polarity).toBe(POLARITY.NEGATIVE);
  });

  test("the more specific pattern wins within one severity", () => {
    const rules = compileRules([
      rule({ pattern: "viz", polarity: POLARITY.SUPPORTIVE }),
      rule({
        pattern: "viz\\s+rozsudek\\s+Nejvyššího",
        polarity: POLARITY.SUPPORTIVE,
      }),
    ]);

    expect(rules.at(0)?.pattern).toBe("viz\\s+rozsudek\\s+Nejvyššího");
  });

  test("neutral loses to positive", () => {
    const rules = compileRules([
      rule({ pattern: "proti\\s+rozsudku", polarity: POLARITY.NEUTRAL }),
      rule({ pattern: "v\\s+souladu\\s+s", polarity: POLARITY.POSITIVE }),
    ]);

    const match = selectRuleMatch(
      rules,
      "V souladu s citovaným rozhodnutím, proti rozsudku odvolacího soudu.",
    );

    expect(match?.polarity).toBe(POLARITY.POSITIVE);
  });

  test("the order does not depend on the order rows arrived in", () => {
    const rows = [
      rule({ pattern: "aaa", polarity: POLARITY.NEUTRAL }),
      rule({ pattern: "bbbb", polarity: POLARITY.NEUTRAL }),
      rule({ pattern: "cc", polarity: POLARITY.NEGATIVE }),
      rule({ pattern: "dddd", polarity: POLARITY.POSITIVE }),
    ];

    const forward = compileRules(rows).map((compiled) => compiled.id);
    const reversed = compileRules([...rows].toReversed()).map(
      (compiled) => compiled.id,
    );

    expect(forward).toEqual(reversed);
  });

  test("a rule carrying a pipeline-only polarity never matches", () => {
    // The CHECK constraint accepts `unknown` on a rule row, so this is
    // reachable from a hand-written insert. It must not become a match: the
    // citation would be labelled "classification did not happen" when the
    // regex tier had in fact just classified it.
    const rules = compileRules([
      rule({ pattern: "viz", polarity: POLARITY.UNKNOWN }),
      rule({ pattern: "viz", polarity: POLARITY.SUPPORTIVE }),
    ]);

    expect(rules).toHaveLength(1);
    expect(selectRuleMatch(rules, "viz nález")?.polarity).toBe(
      POLARITY.SUPPORTIVE,
    );
  });

  test("a rule that does not compile is dropped, not fatal", () => {
    // Dropped, and reported: such a row can never fire, yet it still takes a
    // slot in its tier's budget, so leaving it invisible subtracts from the
    // working set forever.
    const rules = compileRules([
      rule({ pattern: "(unclosed", polarity: POLARITY.NEGATIVE }),
      rule({ pattern: "viz", polarity: POLARITY.SUPPORTIVE }),
    ]);

    expect(rules.map((compiled) => compiled.pattern)).toEqual(["viz"]);
  });

  test("a match carries the rule's stored confidence", () => {
    const rules = compileRules([
      {
        id: createSafeId<"caseLawPolarityRule">(),
        pattern: "viz",
        polarity: POLARITY.SUPPORTIVE,
        confidence: 0.8,
      },
    ]);

    expect(selectRuleMatch(rules, "viz nález")?.confidence).toBe(0.8);
  });

  test("no match returns null", () => {
    const rules = compileRules([
      rule({ pattern: "viz", polarity: POLARITY.SUPPORTIVE }),
    ]);

    expect(selectRuleMatch(rules, "nothing to see here")).toBeNull();
  });
});

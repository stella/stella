/**
 * Seed polarity rules for Czech and Slovak legal texts.
 *
 * These rules cover the most common citation phrases in
 * CZ/SK judicial practice. Based on analysis of the CzCDC
 * corpus (Harasta, Masaryk University).
 */

import type { Polarity } from "./consts";

type SeedRule = {
  pattern: string;
  polarity: Polarity;
  language: string;
};

type RetiredSeedRule = Pick<SeedRule, "pattern" | "language">;

/**
 * The words a court uses for the decision it is treating, as stems so the
 * cases inflect freely. A negative cue anchored on one of these names the
 * cited decision; the same cue without one names a party, a court, a
 * statute or the matter at hand ("na daný případ nelze aplikovat § 1765"),
 * and says nothing about the citation. Words for the matter itself (věc,
 * případ, situace) are deliberately absent for that reason.
 */
const CS_DECISION_ANCHOR =
  "(?:závěr|rozsud|usnesen|nález|judikat|rozhodnut|stanovisk)";
const SK_DECISION_ANCHOR =
  "(?:záver|rozsud|uznesen|nález|judikat|rozhodnut|stanovisk)";

/**
 * What may stand between a cue and its object: up to three plain words,
 * no punctuation. Nearness alone is not binding: "na rozdíl od krajského
 * soudu, jehož rozsudek…" has a decision word within reach but the comma
 * says the cue's object is the court; "Rozsudek uvádí, že § 1765 nelze
 * aplikovat" likewise. A clause break ends the search.
 */
const WORDS_BETWEEN = "(?:[^\\s,;.()]+\\s+){0,3}?";

export const SEED_RULES: readonly SeedRule[] = [
  // -- Czech: positive -------------------------------------------
  { pattern: "v\\s+souladu\\s+s", polarity: "positive", language: "cs" },
  { pattern: "odkazuje\\s+na", polarity: "positive", language: "cs" },
  { pattern: "jak\\s+konstatoval", polarity: "positive", language: "cs" },
  { pattern: "jak\\s+dovodil", polarity: "positive", language: "cs" },
  { pattern: "ve\\s+smyslu\\s+nálezu", polarity: "positive", language: "cs" },
  { pattern: "v\\s+návaznosti\\s+na", polarity: "positive", language: "cs" },
  { pattern: "potvrzuje\\s+závěr", polarity: "positive", language: "cs" },
  { pattern: "v\\s+intencích", polarity: "positive", language: "cs" },
  { pattern: "respektuje\\s+závěr", polarity: "positive", language: "cs" },

  // -- Czech: supportive (implicit reliance) --------------------
  { pattern: "srov\\.", polarity: "supportive", language: "cs" },
  { pattern: "\\bviz\\b", polarity: "supportive", language: "cs" },
  { pattern: "obdobně", polarity: "supportive", language: "cs" },
  { pattern: "přiměřeně", polarity: "supportive", language: "cs" },
  { pattern: "k\\s+tomu\\s+blíže", polarity: "supportive", language: "cs" },
  { pattern: "shodně\\s+též", polarity: "supportive", language: "cs" },
  { pattern: "srovnej", polarity: "supportive", language: "cs" },
  { pattern: "judikoval", polarity: "supportive", language: "cs" },
  { pattern: "odpovídá\\s+závěr", polarity: "supportive", language: "cs" },
  { pattern: "připomíná", polarity: "supportive", language: "cs" },
  { pattern: "lze\\s+odkázat", polarity: "supportive", language: "cs" },
  { pattern: "má\\s+oporu\\s+v", polarity: "supportive", language: "cs" },
  { pattern: "přiléhavě", polarity: "supportive", language: "cs" },
  { pattern: "v\\s+judikatuře", polarity: "supportive", language: "cs" },
  { pattern: "z\\s+judikatury", polarity: "supportive", language: "cs" },

  // -- Czech: neutral (procedural chain) -------------------------
  {
    pattern: "proti\\s+(rozsudku|usnesení|rozhodnutí)",
    polarity: "neutral",
    language: "cs",
  },
  {
    pattern: "veden[éoá]?\\s+(u|pod)",
    polarity: "neutral",
    language: "cs",
  },

  // -- Czech: negative -------------------------------------------
  // A negative cue must have the cited decision as its object. "na rozdíl
  // od" mostly compares parties or courts, and "nelze aplikovat" mostly
  // speaks of a statute; each is a treatment only when what follows is a
  // decision, so the anchor is part of the pattern (see the regression
  // corpus in `__tests__/polarity-classifier.test.ts`).
  {
    pattern: `na\\s+rozdíl\\s+od\\s+${WORDS_BETWEEN}${CS_DECISION_ANCHOR}`,
    polarity: "negative",
    language: "cs",
  },
  { pattern: "překonán[aouy]?", polarity: "negative", language: "cs" },
  { pattern: "odchyluje\\s+se", polarity: "negative", language: "cs" },
  {
    pattern: `nelze\\s+aplikovat\\s+${WORDS_BETWEEN}${CS_DECISION_ANCHOR}`,
    polarity: "negative",
    language: "cs",
  },
  // The decision may be named before the cue ("tento rozsudek však nelze
  // aplikovat"); within the same clause the object still binds.
  {
    pattern: `\\b${CS_DECISION_ANCHOR}\\w*\\s+${WORDS_BETWEEN}nelze\\s+aplikovat`,
    polarity: "negative",
    language: "cs",
  },
  { pattern: "odlišuje\\s+se\\s+od", polarity: "negative", language: "cs" },
  { pattern: "nesprávně\\s+dovodil", polarity: "negative", language: "cs" },

  // -- Slovak: positive ------------------------------------------
  { pattern: "v\\s+súlade\\s+s", polarity: "positive", language: "sk" },
  { pattern: "odkazuje\\s+na", polarity: "positive", language: "sk" },
  { pattern: "ako\\s+konštatoval", polarity: "positive", language: "sk" },
  { pattern: "potvrdzuje\\s+záver", polarity: "positive", language: "sk" },

  // -- Slovak: supportive (implicit reliance) -------------------
  { pattern: "porov\\.", polarity: "supportive", language: "sk" },
  { pattern: "pozri", polarity: "supportive", language: "sk" },
  { pattern: "obdobne", polarity: "supportive", language: "sk" },

  // -- Slovak: negative ------------------------------------------
  {
    pattern: `na\\s+rozdiel\\s+od\\s+${WORDS_BETWEEN}${SK_DECISION_ANCHOR}`,
    polarity: "negative",
    language: "sk",
  },
  { pattern: "prekonan[áéý]?", polarity: "negative", language: "sk" },
  { pattern: "odlišuje\\s+sa\\s+od", polarity: "negative", language: "sk" },
];

/**
 * Rules withdrawn from the seed. Seeding marks their rows `retired` rather
 * than deleting them, so the match counts they accumulated stay readable.
 *
 * "byl zrušen" names the fate of a judgment under review far more often than
 * a precedent being overruled, and it sits next to the citations of whatever
 * quashed it, so as a negative cue it mislabelled the authority it invoked.
 *
 * "neobstojí" is what a court says of a party's objection ("námitka
 * neobstojí"), never of the precedent it cites beside it; "na rozdíl od" and
 * "nelze aplikovat" without an object are comparisons of parties and courts
 * and statements about statutes. Sampled on the corpus they were wrong in
 * 14 of 21 windows and never right without the anchor their replacements
 * carry. Retiring a rule resets the rows it labelled, so they are read again.
 */
export const RETIRED_SEED_RULES: readonly RetiredSeedRule[] = [
  { pattern: "byl[aoyi]?\\s+zrušen[aouy]?", language: "cs" },
  { pattern: "bol[aoi]?\\s+zrušen[áéý]?", language: "sk" },
  { pattern: "neobstojí", language: "cs" },
  { pattern: "na\\s+rozdíl\\s+od", language: "cs" },
  { pattern: "nelze\\s+aplikovat", language: "cs" },
  { pattern: "na\\s+rozdiel\\s+od", language: "sk" },
];

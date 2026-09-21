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

/**
 * The bodies whose departure from a decision is a doctrinal act. A velký
 * senát, a rozšířený senát or the plenum sits to settle a divided practice,
 * so when one says it departs from a line of decisions, that line is
 * overruled. The verb on its own is not the cue: "odvolací soud se odchýlil
 * od ustálené rozhodovací praxe" is the § 237 o. s. ř. formula, said of the
 * court below, and it sits next to the very authorities the citing court is
 * upholding.
 */
const CS_UNIFYING_BODY =
  "(?:velk(?:ý|ého|ému|ým)\\s+senát\\p{L}*|rozšířen(?:ý|ého|ému|ým)\\s+senát\\p{L}*|plén(?:um|a|em|u))";
const SK_UNIFYING_BODY = "(?:veľk(?:ý|ého|ému|ým)\\s+senát\\p{L}*)";

/**
 * The verbs of departure, with the reflexive in the places Czech puts it:
 * second in the clause ("velký senát se od těchto závěrů odchyluje", "od
 * závěru se velký senát odchyluje") or, in a fronted clause, after the verb.
 * A cue written verb-first only ("odchyluje se") reads none of the first two,
 * which is how a velký senát judgment came to be filed as approving the
 * decision it overruled. One rule per word order: the rule column holds 512
 * characters, and the three orders in one alternation do not fit.
 */
const CS_DEPARTS = "(?:odchyluj[eí]|odchýlil[aoy]?|odklání|odklonil[aoy]?)";
/**
 * "se velký senát odchýlil v rozsudku sp. zn. …" names the ruling the body
 * departed IN, and the citation that follows is the overruling authority,
 * not the overruled one. The cue stays silent there rather than label the
 * body's own ruling negative; the overruled line is read where it is named
 * as the object of the departure.
 */
const CS_NOT_IN_OWN_RULING =
  "(?!\\s+v\\s+(?:rozsudku|usnesení|nálezu|stanovisku))";
// The verb ends at a word boundary before the lookahead: the departure verbs
// carry an optional ending, and without the boundary the engine gives the
// ending up to slip past the guard ("odchýlil|o v nálezu").
const CS_BODY_DEPARTS = [
  `${CS_UNIFYING_BODY}\\s+se\\s+${WORDS_BETWEEN}${CS_DEPARTS}\\b${CS_NOT_IN_OWN_RULING}`,
  `\\bse\\s+${CS_UNIFYING_BODY}\\s+${WORDS_BETWEEN}${CS_DEPARTS}\\b${CS_NOT_IN_OWN_RULING}`,
  `${CS_UNIFYING_BODY}\\s+${WORDS_BETWEEN}${CS_DEPARTS}\\s+se\\b${CS_NOT_IN_OWN_RULING}`,
] as const;
const SK_DEPARTS = "(?:odchyľuj[eú]|odchýlil[aoy]?|odkláňa|odklonil[aoy]?)";
const SK_NOT_IN_OWN_RULING =
  "(?!\\s+v\\s+(?:rozsudku|uznesení|náleze|stanovisku))";
const SK_BODY_DEPARTS = [
  `${SK_UNIFYING_BODY}\\s+sa\\s+${WORDS_BETWEEN}${SK_DEPARTS}\\b${SK_NOT_IN_OWN_RULING}`,
  `\\bsa\\s+${SK_UNIFYING_BODY}\\s+${WORDS_BETWEEN}${SK_DEPARTS}\\b${SK_NOT_IN_OWN_RULING}`,
  `${SK_UNIFYING_BODY}\\s+${WORDS_BETWEEN}${SK_DEPARTS}\\s+sa\\b${SK_NOT_IN_OWN_RULING}`,
] as const;

/**
 * The docket numbers the Nejvyšší soud gives its velký senát: chambers 15,
 * 31 and 35. A practice "změněna rozsudkem ze dne …, sp. zn. 31 Cdo …" names
 * an overruling by docket alone; a judgment under review "byl změněn
 * rozsudkem ze dne …" of an appellate court never carries one of these.
 */
const CS_GRAND_CHAMBER_DOCKET =
  "ze\\s+dne\\s+[\\d.\\s]+,\\s+sp\\.\\s+zn\\.\\s+(?:15|31|35)\\s+Cdo";

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
  // aplikovat"); within the same clause the object still binds. The anchor
  // inflects with `\p{L}*`, not `\w*`: with the `u` flag `\w` is still ASCII,
  // so "závěrů" and "usnesení" ended the match at their first accented
  // letter and the cue never fired on them.
  {
    pattern: `\\b${CS_DECISION_ANCHOR}\\p{L}*\\s+${WORDS_BETWEEN}nelze\\s+aplikovat`,
    polarity: "negative",
    language: "cs",
  },
  { pattern: "odlišuje\\s+se\\s+od", polarity: "negative", language: "cs" },
  { pattern: "nesprávně\\s+dovodil", polarity: "negative", language: "cs" },
  // What a unifying body says when it overrules: it departs, it overcomes,
  // it abandons, it does not share, and the practice "byla změněna" by its
  // ruling. Each cue is bound to the body or to a decision word so the
  // appellate-court formula stays out of it. A party reporting the body's
  // departure reads the same as the body; the rule tier has no speaker
  // guard, and that is the tier's known limit, not this cue's.
  ...CS_BODY_DEPARTS.map((pattern): SeedRule => ({
    pattern,
    polarity: "negative",
    language: "cs",
  })),
  {
    pattern: `překonáv(?:á|ají)\\s+${WORDS_BETWEEN}${CS_DECISION_ANCHOR}`,
    polarity: "negative",
    language: "cs",
  },
  {
    pattern: `překonal[aoy]?\\s+${WORDS_BETWEEN}${CS_DECISION_ANCHOR}`,
    polarity: "negative",
    language: "cs",
  },
  {
    pattern: `(?:opouští|opustil[aoy]?)\\s+${WORDS_BETWEEN}${CS_DECISION_ANCHOR}`,
    polarity: "negative",
    language: "cs",
  },
  // "byla změněna rozsudkem velkého senátu" or "… rozsudkem ze dne …, sp. zn.
  // 31 Cdo …" is said of a practice. A judgment under review is also "změněn
  // rozsudkem ze dne …", by the appellate court, so the date alone is not the
  // cue: the body or its docket is.
  {
    pattern: `změněn[aoy]?\\s+(?:rozsudkem|usnesením|nálezem|stanoviskem)\\s+(?:${CS_UNIFYING_BODY}|${CS_GRAND_CHAMBER_DOCKET})`,
    polarity: "negative",
    language: "cs",
  },
  {
    pattern: `nesdílí\\s+${WORDS_BETWEEN}(?:názor|závěr)\\p{L}*\\s+(?:vyslovený|vyjádřený|formulovaný|přijatý|zaujatý)\\s+${WORDS_BETWEEN}${CS_DECISION_ANCHOR}`,
    polarity: "negative",
    language: "cs",
  },
  {
    pattern: `nelze\\s+nadále\\s+${WORDS_BETWEEN}${CS_DECISION_ANCHOR}`,
    polarity: "negative",
    language: "cs",
  },
  {
    pattern: `\\b${CS_DECISION_ANCHOR}\\p{L}*\\s+${WORDS_BETWEEN}nelze\\s+nadále`,
    polarity: "negative",
    language: "cs",
  },
  {
    pattern: `\\b${CS_DECISION_ANCHOR}\\p{L}*\\s+${WORDS_BETWEEN}nadále\\s+neobstoj`,
    polarity: "negative",
    language: "cs",
  },
  {
    pattern: "k\\s+závěru\\s+odlišnému\\s+od",
    polarity: "negative",
    language: "cs",
  },

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
  ...SK_BODY_DEPARTS.map((pattern): SeedRule => ({
    pattern,
    polarity: "negative",
    language: "sk",
  })),
  {
    pattern: `prekonáva\\s+${WORDS_BETWEEN}${SK_DECISION_ANCHOR}`,
    polarity: "negative",
    language: "sk",
  },
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
 *
 * The anchored "nelze aplikovat" with `\w*` is superseded by the same rule
 * with `\p{L}*`; the ASCII-only inflection silently missed accented endings.
 */
export const RETIRED_SEED_RULES: readonly RetiredSeedRule[] = [
  { pattern: "byl[aoyi]?\\s+zrušen[aouy]?", language: "cs" },
  { pattern: "bol[aoi]?\\s+zrušen[áéý]?", language: "sk" },
  { pattern: "neobstojí", language: "cs" },
  { pattern: "na\\s+rozdíl\\s+od", language: "cs" },
  { pattern: "nelze\\s+aplikovat", language: "cs" },
  { pattern: "na\\s+rozdiel\\s+od", language: "sk" },
  {
    pattern: `\\b${CS_DECISION_ANCHOR}\\w*\\s+${WORDS_BETWEEN}nelze\\s+aplikovat`,
    language: "cs",
  },
];

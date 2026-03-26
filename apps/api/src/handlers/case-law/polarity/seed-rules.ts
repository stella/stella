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

export const SEED_RULES: SeedRule[] = [
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

  // -- Czech: negative -------------------------------------------
  { pattern: "na\\s+rozdíl\\s+od", polarity: "negative", language: "cs" },
  { pattern: "překonán[aouy]?", polarity: "negative", language: "cs" },
  {
    pattern: "byl[aoyi]?\\s+zrušen[aouy]?",
    polarity: "negative",
    language: "cs",
  },
  { pattern: "odchyluje\\s+se", polarity: "negative", language: "cs" },
  { pattern: "nelze\\s+aplikovat", polarity: "negative", language: "cs" },
  { pattern: "odlišuje\\s+se\\s+od", polarity: "negative", language: "cs" },
  { pattern: "nesprávně\\s+dovodil", polarity: "negative", language: "cs" },
  { pattern: "neobstojí", polarity: "negative", language: "cs" },

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
  { pattern: "na\\s+rozdiel\\s+od", polarity: "negative", language: "sk" },
  { pattern: "prekonan[áéý]?", polarity: "negative", language: "sk" },
  {
    pattern: "bol[aoi]?\\s+zrušen[áéý]?",
    polarity: "negative",
    language: "sk",
  },
  { pattern: "odlišuje\\s+sa\\s+od", polarity: "negative", language: "sk" },
];

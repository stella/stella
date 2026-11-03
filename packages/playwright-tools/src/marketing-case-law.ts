import cs from "./marketing-case-law.cs.json" with { type: "json" };
import en from "./marketing-case-law.json" with { type: "json" };
import sk from "./marketing-case-law.sk.json" with { type: "json" };
import type { MarketingLocale } from "./marketing-locales";

/**
 * One filmed case-law reader: a published decision, two marked paragraphs
 * (by anchor and published number), the AI margin note and the reader's
 * comment on them, and a two-turn chat about the decision. Everything here
 * is written by hand; the seed stores it, nothing generates it.
 */
export type MarketingCaseLawScenario = {
  country: string;
  caseNumber: string;
  language: string;
  highlightAnchor: string;
  underlineAnchor: string;
  aiNote: string;
  comment: string;
  question: string;
  answer: string;
  followUp: string;
  followUpAnswer: string;
  highlightNumber: number;
  underlineNumber: number;
};

// The seed writes each scenario's analysis onto the shared decision row, so
// two locales must never film the same decision: each would overwrite the
// other's margin note.
export const MARKETING_CASE_LAW: Record<
  MarketingLocale,
  readonly MarketingCaseLawScenario[]
> = { en, cs, sk };

// The seeded analysis text is in the firm's language
// (MARKETING_LOCALE_ACCOUNTS[locale].language).
type MarketingCaseLawCopy = {
  issueLabel: string;
  outcomeLabel: string;
  threadTitlePrefix: string;
};

export const MARKETING_CASE_LAW_COPY = {
  en: {
    issueLabel: "Legal issue",
    outcomeLabel: "Outcome",
    threadTitlePrefix: "Case review",
  },
  cs: {
    issueLabel: "Právní otázka",
    outcomeLabel: "Závěr soudu",
    threadTitlePrefix: "Rozbor rozhodnutí",
  },
  sk: {
    issueLabel: "Právna otázka",
    outcomeLabel: "Záver súdu",
    threadTitlePrefix: "Rozbor rozhodnutia",
  },
} as const satisfies Record<MarketingLocale, MarketingCaseLawCopy>;

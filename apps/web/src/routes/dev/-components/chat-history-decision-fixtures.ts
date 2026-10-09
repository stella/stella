import type { CourtTierLabel } from "@stll/api-contract/case-law-court-tiers";

import type { ChatHistoryItem } from "@/features/chat/queries";
import { toSafeId } from "@/lib/safe-id";
import type { ChatThreadDecision } from "@/routes/_protected.chat/-components/chat-thread-decision";

const BASE_DECISION = {
  caseNumber: "25 Cdo 1234/2021",
  country: "CZE",
  court: "Nejvyšší soud",
  courtAbbreviation: "NS",
  courtTier: "supreme",
  decisionDate: "2021-03-12",
  id: toSafeId<"caseLawDecision">("00000000-0000-0000-0000-000000000006"),
  language: "cs",
  languageAlternates: [],
  slug: "bench-decision",
} satisfies ChatThreadDecision;

// Total over the API's tiers so a new badge treatment requires a fixture.
const TIER_DECISIONS = {
  constitutional: {
    ...BASE_DECISION,
    court: "Ústavní soud",
    courtAbbreviation: "ÚS",
    courtTier: "constitutional",
    caseNumber: "Pl. ÚS 20/21",
  },
  supreme: BASE_DECISION,
  regional: {
    ...BASE_DECISION,
    court: "Krajský soud v Brně",
    courtAbbreviation: "KS",
    courtTier: "regional",
    caseNumber: "44 Co 72/2021",
  },
  other: {
    ...BASE_DECISION,
    court: "Okresní soud v Olomouci",
    courtAbbreviation: "OS",
    courtTier: "other",
    caseNumber: "12 C 48/2021",
  },
} as const satisfies Record<CourtTierLabel, ChatThreadDecision>;

type HistoryFixture = {
  state: string;
  title: string;
  decision: ChatHistoryItem["decision"];
};

export const CHAT_HISTORY_DECISION_FIXTURES = [
  ...Object.entries(TIER_DECISIONS).map(
    ([state, badge]) =>
      ({
        state,
        title: "Náhrada újmy při porušení smlouvy",
        decision: { type: "present", badge },
      }) satisfies HistoryFixture,
  ),
  {
    state: "no-abbreviation",
    title: "Příslušnost soudu ve smluvním sporu",
    decision: {
      type: "present",
      badge: { ...BASE_DECISION, courtAbbreviation: null },
    },
  },
  {
    state: "long-abbreviation",
    title: "Přezkum rozhodnutí zahraničního soudu",
    decision: {
      type: "present",
      badge: {
        ...BASE_DECISION,
        court: "Kúria",
        courtAbbreviation: "Kúria",
        country: "HUN",
        language: "hu",
      },
    },
  },
  {
    state: "no-date",
    title: "Počátek běhu promlčecí lhůty",
    decision: {
      type: "present",
      badge: { ...BASE_DECISION, decisionDate: null },
    },
  },
  {
    state: "unavailable",
    title: "Výklad smluvního ujednání",
    decision: { type: "unavailable" },
  },
  {
    state: "ordinary",
    title: "Příprava podkladů k jednání",
    decision: null,
  },
] as const satisfies readonly HistoryFixture[];

import type { api } from "@/lib/api";
import type { PublicLawData } from "@/lib/public-law-api";

/**
 * One public decision as the read answers it. The id and by-slug routes share
 * one handler, so either read yields this shape. The body flags
 * (`documentPending`, `documentReadFailed`, `documentUnavailable`) say why the
 * text is absent; see `decision-body-state.logic`.
 */
export type PublicCaseLawDecision = PublicLawData<
  ReturnType<typeof api.case.decisions>["get"]
>;

export type PublicDecisionLanguageAlternate =
  PublicCaseLawDecision["languageAlternates"][number];

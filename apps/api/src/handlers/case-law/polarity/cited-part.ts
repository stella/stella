import { CITED_PART } from "@/api/lib/case-law/citation-vocabulary";
import type { CitedPart } from "@/api/lib/case-law/citation-vocabulary";

/** Explicit opinion names only: a bare judge name does not establish authorship. */
export const CITED_PART_CUES = {
  cs: {
    dissent:
      /(?<!\p{L})(?:odlišn\p{L}*|disentn\p{L}*)\s+(?:stanovisk\p{L}*|názor\p{L}*)/iu,
    concurrence: /(?<!\p{L})konkurujíc\p{L}*\s+stanovisk\p{L}*/iu,
    majority: /(?<!\p{L})většinov\p{L}*\s+(?:stanovisk\p{L}*|názor\p{L}*)/iu,
  },
  sk: {
    dissent:
      /(?<!\p{L})(?:odlišn\p{L}*|disentn\p{L}*)\s+(?:stanovisk\p{L}*|názor\p{L}*)/iu,
    concurrence: /(?<!\p{L})súhlasn\p{L}*\s+stanovisk\p{L}*/iu,
    majority: /(?<!\p{L})väčšinov\p{L}*\s+(?:stanovisk\p{L}*|názor\p{L}*)/iu,
  },
  en: {
    dissent: /(?<!\p{L})(?:dissent(?:ing)?|separate)\s+opinion(?!\p{L})/iu,
    concurrence: /(?<!\p{L})(?:concurring\s+opinion|concurrence)(?!\p{L})/iu,
    majority: /(?<!\p{L})majority\s+opinion(?!\p{L})/iu,
  },
} satisfies Record<string, Record<Exclude<CitedPart, "not-stated">, RegExp>>;

/** Conflicting opinion names cannot identify one target; leave it unspecified. */
export const classifyCitedPart = (
  contexts: readonly string[],
  language: string,
): CitedPart => {
  const cues = Object.entries(CITED_PART_CUES).find(
    ([key]) => key === language,
  )?.[1];
  if (!cues) {
    return CITED_PART.NOT_STATED;
  }
  const text = contexts.join("\n").normalize("NFC");
  const matches = [
    ...(cues.dissent.test(text) ? [CITED_PART.DISSENT] : []),
    ...(cues.concurrence.test(text) ? [CITED_PART.CONCURRENCE] : []),
    ...(cues.majority.test(text) ? [CITED_PART.MAJORITY] : []),
  ];
  const part = matches.at(0);
  return matches.length === 1 && part ? part : CITED_PART.NOT_STATED;
};

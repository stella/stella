/**
 * Pure scoring for the playbook-authoring eval's behavior tier: how the
 * questions a run asked read, and whether a save resent a position it did not
 * change. No model and no store; the eval gathers the evidence.
 */

import type { Position } from "@/api/lib/workflow/playbook-positions";

const QUESTION_TOPICS = [
  "contracts",
  "language",
  "law",
  "side",
  "type",
] as const;

export type QuestionTopic = (typeof QUESTION_TOPICS)[number];

/**
 * First match wins, so the order settles a question that names two topics:
 * "Which law governs the contracts you attached?" is about the law.
 */
const TOPIC_PATTERNS = [
  ["language", /\blanguages?\b/iu],
  [
    "law",
    /\b(governing law|jurisdiction|which law|law (?:should |will )?govern)/iu,
  ],
  [
    "contracts",
    /\b(executed|signed|attach\w*)\b|\b(past|previous|existing|prior|your own)\b.*\b(contracts?|agreements?|documents?|ndas?|dpas?|msas?)\b/iu,
  ],
  [
    "side",
    /\b(side|which party|perspective|role|represent|are you the|are we the|acting for|on behalf of|as the (customer|buyer|seller|supplier|vendor|discloser|disclosing party|recipient|receiving party|licensor|licensee|controller|processor))\b/iu,
  ],
  [
    "type",
    /\b(type|kind) of (contract|agreement)|\b(contract|agreement) type\b/iu,
  ],
] as const satisfies readonly (readonly [QuestionTopic, RegExp])[];

export const classifyQuestion = (text: string): QuestionTopic | null =>
  TOPIC_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? null;

/**
 * Issues of the positions a save named by `source_id` and left exactly as
 * they were: resent, not changed. A replace keeps rule ids and the derived ask
 * when nothing changed, so an unchanged resend stores an equal position.
 */
export const findUnchangedResends = ({
  input,
  before,
  after,
}: {
  input: unknown;
  before: readonly Position[];
  after: readonly Position[];
}): string[] => {
  if (typeof input !== "object" || input === null || !("positions" in input)) {
    return [];
  }
  const { positions } = input;
  if (!Array.isArray(positions)) {
    return [];
  }
  const resent: string[] = [];
  for (const entry of positions) {
    const sourceId: unknown =
      typeof entry === "object" && entry !== null && "source_id" in entry
        ? entry.source_id
        : undefined;
    if (typeof sourceId !== "string") {
      continue;
    }
    const stored = before.find((position) => position.sourceId === sourceId);
    const saved = after.find((position) => position.sourceId === sourceId);
    if (stored !== undefined && Bun.deepEquals(stored, saved)) {
      resent.push(stored.issue);
    }
  }
  return resent;
};

/** Letters Czech writes and English, German, and Dutch do not. */
const CZECH_LETTERS = /[ěščřžůťďň]/iu;

export const isCzech = (text: string): boolean => CZECH_LETTERS.test(text);

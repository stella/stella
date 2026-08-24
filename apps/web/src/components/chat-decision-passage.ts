/**
 * A passage of a case-law decision on its way into the chat composer, by
 * drag or by "Ask AI". It lands as two chips: the words as a pasted-text
 * chip labelled with the case number, and the decision as a mention, which
 * is the reference the corpus tools read the decision by.
 */

import type { JSONContent } from "@tiptap/core";
import * as v from "valibot";

import { resourceRef, RESOURCE_TYPE } from "@stll/api-contract";

import type { ChatMentionOption } from "@/components/chat-mention-extension";
import { toChatMentionNodeAttrs } from "@/components/chat-mention-node-attrs";
import { PASTED_TEXT_NODE_NAME } from "@/components/chat-pasted-text-extension";
import type { PastedTextAttrs } from "@/components/chat-pasted-text-extension";
import { toSafeId } from "@/lib/safe-id";

/** The drag payload type; a plain-text copy rides alongside for other targets. */
export const DECISION_PASSAGE_MIME = "application/x-stella-decision-passage";

const decisionPassageSchema = v.strictObject({
  caseNumber: v.pipe(v.string(), v.trim(), v.nonEmpty()),
  court: v.string(),
  decisionId: v.pipe(v.string(), v.nonEmpty()),
  quote: v.pipe(v.string(), v.trim(), v.nonEmpty()),
});

export type DecisionPassage = v.InferOutput<typeof decisionPassageSchema>;

export const writeDecisionPassage = (
  dataTransfer: DataTransfer,
  passage: DecisionPassage,
): void => {
  dataTransfer.setData(DECISION_PASSAGE_MIME, JSON.stringify(passage));
  dataTransfer.setData("text/plain", passage.quote);
  dataTransfer.effectAllowed = "copy";
};

export const readDecisionPassage = (
  dataTransfer: DataTransfer,
): DecisionPassage | null => {
  const raw = dataTransfer.getData(DECISION_PASSAGE_MIME);
  if (raw === "") {
    return null;
  }
  const parsed = v.safeParse(
    v.pipe(v.string(), v.parseJson(), decisionPassageSchema),
    raw,
  );
  return parsed.success ? parsed.output : null;
};

export const decisionPassageChip = ({
  caseNumber,
  quote,
}: DecisionPassage): PastedTextAttrs => ({
  label: caseNumber,
  source: "paste",
  text: quote.replace(/\s+/gu, " ").trim(),
});

export const decisionPassageMention = ({
  caseNumber,
  decisionId,
}: DecisionPassage): ChatMentionOption => ({
  category: "decision",
  kind: "decision",
  label: caseNumber,
  mimeType: null,
  resource: resourceRef({
    type: RESOURCE_TYPE.CASE_LAW_DECISION,
    id: toSafeId<"caseLawDecision">(decisionId),
  }),
});

/** The composer content for a passage: its chip, the decision, a space. */
export const decisionPassageContent = (
  passage: DecisionPassage,
): JSONContent[] => [
  { type: PASTED_TEXT_NODE_NAME, attrs: decisionPassageChip(passage) },
  { type: "text", text: " " },
  {
    type: "mention",
    attrs: toChatMentionNodeAttrs(decisionPassageMention(passage)),
  },
  { type: "text", text: " " },
];

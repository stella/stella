import {
  OUTLOOK_AI_FROM_MAX_CHARS,
  OUTLOOK_AI_SUBJECT_MAX_CHARS,
  truncateOutlookAIInput,
} from "@stll/api-contract/outlook-ai";

import type { MailSnapshot } from "@/types";

export const buildAISummaryRequest = ({
  language,
  text,
}: {
  language?: string | undefined;
  text: string;
}) => ({
  text: truncateOutlookAIInput(text),
  ...(language ? { language } : {}),
});

export const buildAIDraftRequest = ({
  intent,
  language,
  snapshot,
}: {
  intent: string;
  language?: string | undefined;
  snapshot: MailSnapshot;
}) => {
  // An address longer than the endpoint takes is not a usable sender; a long
  // subject is cut, since its start carries the meaning.
  const sender = snapshot.from?.email;
  const originalFrom =
    sender && sender.length <= OUTLOOK_AI_FROM_MAX_CHARS ? sender : undefined;
  return {
    intent,
    originalBody: truncateOutlookAIInput(snapshot.bodyText),
    originalSubject: snapshot.subject.slice(0, OUTLOOK_AI_SUBJECT_MAX_CHARS),
    ...(originalFrom ? { originalFrom } : {}),
    ...(language ? { language } : {}),
  };
};

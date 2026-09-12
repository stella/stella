import { truncateOutlookAIInput } from "@stll/api-contract";

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
  const originalFrom = snapshot.from?.email;
  return {
    intent,
    originalBody: truncateOutlookAIInput(snapshot.bodyText),
    originalSubject: snapshot.subject,
    ...(originalFrom ? { originalFrom } : {}),
    ...(language ? { language } : {}),
  };
};

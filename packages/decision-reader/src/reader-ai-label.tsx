import { AI_DISCLOSURES } from "@stll/api-contract/ai-disclosure";
import type { AiDisclosureContext } from "@stll/api-contract/ai-disclosure";
import { AiLabel } from "@stll/ui/ai-label";

import { useReaderMessages } from "./reader-adapters";

/**
 * The shared AI mark, worded from the host's reader messages: the reader
 * names a disclosure context and the host's catalogue supplies its sentence,
 * so no call site can pass a sentence of its own.
 */
export const ReaderAiLabel = ({
  context,
  label,
}: {
  context: AiDisclosureContext;
  /** The mark's visible words, already translated. */
  label: string;
}) => {
  const messages = useReaderMessages();
  return (
    <AiLabel
      disclosure={messages[AI_DISCLOSURES[context].messageKey]}
      label={label}
    />
  );
};

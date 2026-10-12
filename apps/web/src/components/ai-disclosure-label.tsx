import { useTranslations } from "use-intl";

import { AI_DISCLOSURES } from "@stll/api-contract/ai-disclosure";
import type { AiDisclosureContext } from "@stll/api-contract/ai-disclosure";
import { AiLabel } from "@stll/ui/ai-label";

/**
 * The shared AI mark for the web app: a call site names the disclosure
 * context and the catalogue supplies its sentence in the reader's language,
 * so no surface can word the disclosure on its own.
 */
export const AiDisclosureLabel = ({
  context,
  label,
}: {
  context: AiDisclosureContext;
  /** The mark's visible words, already translated. */
  label: string;
}) => {
  const t = useTranslations();
  return (
    <AiLabel disclosure={t(AI_DISCLOSURES[context].messageKey)} label={label} />
  );
};

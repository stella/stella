import { useTranslations } from "use-intl";

import { InfoIcon } from "@stll/ui/icons";

/**
 * Shown above a decision the reader opened by a bare docket that found one
 * decision in a case file whose other decisions the read may not have
 * reached. It says only that the file may hold more, never that this one is
 * the only one.
 */
export const PublicDecisionFileNote = () => {
  const t = useTranslations();
  return (
    <p
      className="text-muted-foreground flex items-start gap-2 border-b px-4 py-2 text-sm text-pretty"
      role="note"
    >
      <InfoIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>{t("caseLaw.viewer.caseFileMayHoldOthers")}</span>
    </p>
  );
};

import { useTranslations } from "use-intl";

import { sanitizeHref } from "@stll/decision-reader/sanitize-href";

export const PublicDecisionTextNotice = ({
  sourceUrl,
}: {
  sourceUrl: string | null;
}) => {
  const t = useTranslations();
  const href = sanitizeHref(sourceUrl);
  return (
    <div className="flex min-w-0 flex-1 flex-col items-center gap-3 px-6 py-16">
      <p className="text-muted-foreground text-sm text-balance">
        {t("caseLaw.viewer.textNotYetAvailable")}
      </p>
      {href !== undefined && (
        <a
          className="text-sm underline"
          href={sanitizeHref(href)}
          rel="noopener noreferrer"
          target="_blank"
        >
          {t("inspector.external.openOriginal")}
        </a>
      )}
    </div>
  );
};

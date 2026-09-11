import { ExternalLinkIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import Tooltip from "@/components/tooltip";
import { sanitizeHref } from "@/lib/sanitize-href";

type OpenOriginalButtonProps = {
  className?: string | undefined;
  href: string | null | undefined;
};

/** One compact source affordance for every public legal reader. */
export const OpenOriginalButton = ({
  className,
  href,
}: OpenOriginalButtonProps) => {
  const t = useTranslations();
  const safeHref = sanitizeHref(href);
  if (safeHref === undefined) {
    return null;
  }

  return (
    <Tooltip
      content={t("inspector.external.openOriginal")}
      render={
        <Button
          className={className}
          render={
            <a
              href={sanitizeHref(safeHref)}
              rel="noopener noreferrer"
              target="_blank"
            >
              <ExternalLinkIcon aria-hidden="true" className="size-4" />
              <span className="sr-only">
                {t("inspector.external.openOriginal")}
              </span>
            </a>
          }
          size="icon-sm"
          variant="ghost"
        />
      }
    />
  );
};

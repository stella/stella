import { ExternalLinkIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { cn } from "@stll/ui/utils";

import Tooltip from "@/components/tooltip";
import { sanitizeHref } from "@/lib/sanitize-href";

/** The scales the button is used at: a section row, and a tab header. */
const GLYPH_SIZE = {
  "icon-sm": "size-4",
  "icon-xs": "size-3.5",
} as const;

type OpenOriginalButtonSize = keyof typeof GLYPH_SIZE;

type OpenOriginalButtonProps = {
  className?: string | undefined;
  href: string | null | undefined;
  size?: OpenOriginalButtonSize | undefined;
};

/** One compact source affordance for every public legal reader. */
export const OpenOriginalButton = ({
  className,
  href,
  size = "icon-sm",
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
              <ExternalLinkIcon
                aria-hidden="true"
                className={cn(GLYPH_SIZE[size])}
              />
              <span className="sr-only">
                {t("inspector.external.openOriginal")}
              </span>
            </a>
          }
          size={size}
          variant="ghost"
        />
      }
    />
  );
};

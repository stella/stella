import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

type SearchMatchControlsProps = {
  activeIndex: number;
  matchCount: number;
  onNext: () => void;
  onPrevious: () => void;
  truncated?: boolean | undefined;
};

export const SearchMatchControls = ({
  activeIndex,
  matchCount,
  onNext,
  onPrevious,
  truncated = false,
}: SearchMatchControlsProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const hasMatches = matchCount > 0;

  return (
    <div className="flex items-center gap-0.5">
      <span className="text-muted-foreground min-w-12 text-center text-xs tabular-nums">
        {hasMatches
          ? t("folio.findReplace.matchCounter", {
              current: format.number(activeIndex + 1),
              total: `${format.number(matchCount)}${truncated ? "+" : ""}`,
            })
          : t("common.noResults")}
      </span>
      <Button
        aria-label={t("folio.findReplace.previous")}
        disabled={!hasMatches}
        onClick={onPrevious}
        size="icon-xs"
        title={t("folio.findReplace.previous")}
        variant="ghost"
      >
        <ChevronUpIcon className="size-3.5" />
      </Button>
      <Button
        aria-label={t("folio.findReplace.next")}
        disabled={!hasMatches}
        onClick={onNext}
        size="icon-xs"
        title={t("folio.findReplace.next")}
        variant="ghost"
      >
        <ChevronDownIcon className="size-3.5" />
      </Button>
    </div>
  );
};

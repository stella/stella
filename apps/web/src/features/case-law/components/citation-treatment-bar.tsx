import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/utils";

import {
  CITATION_TREATMENT_DOT,
  CITATION_TREATMENT_LABEL,
  CITATION_TREATMENT_ORDER,
} from "@/features/case-law/citation-treatment";
import type { CitationTreatmentCounts } from "@/features/case-law/citation-treatment";
import { useFormatter } from "@/i18n/formatting-context";

type CitationTreatmentBarProps = {
  className?: string | undefined;
  counts: CitationTreatmentCounts;
  total: number;
};

/**
 * The reception in one line: each treatment's share of the citations, in
 * display order, in the colour its label carries elsewhere. No axis and no
 * legend of its own; the counts beneath it or the headings below name the
 * colours. A sliver that would be invisible is still drawn one pixel wide,
 * so a lone negative is never lost.
 */
export const CitationTreatmentBar = ({
  className,
  counts,
  total,
}: CitationTreatmentBarProps) => {
  const t = useTranslations();
  const format = useFormatter();

  return (
    <div
      aria-label={CITATION_TREATMENT_ORDER.filter(
        (treatment) => counts[treatment] > 0,
      )
        .map(
          (treatment) =>
            `${t(CITATION_TREATMENT_LABEL[treatment])}: ${format.number(counts[treatment])}`,
        )
        .join(", ")}
      className={cn(
        "bg-muted/40 flex h-1 w-full gap-px overflow-hidden rounded-full",
        className,
      )}
      role="img"
    >
      {CITATION_TREATMENT_ORDER.map((treatment) =>
        counts[treatment] === 0 ? null : (
          <span
            className={cn("min-w-px", CITATION_TREATMENT_DOT[treatment])}
            key={treatment}
            style={{ flexGrow: counts[treatment] / total }}
          />
        ),
      )}
    </div>
  );
};

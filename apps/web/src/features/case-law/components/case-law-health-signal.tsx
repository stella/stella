import { useTranslations } from "use-intl";

import { ReviewStatusDot } from "@stll/ui/review-severity-dot";
import type { ReviewStatusTone } from "@stll/ui/review-status-badge";
import { cn } from "@stll/ui/utils";

import type { caseLawCorpusStatusOptions } from "@/features/case-law/queries/decisions";
import type { TranslationKey } from "@/i18n/types";

/**
 * How current a country's or a source's case law is. The API derives it once,
 * for the coverage page and for the badge beside the search box alike, so the
 * two can never disagree about the same country.
 */
export type CaseLawHealth = Awaited<
  ReturnType<
    NonNullable<ReturnType<typeof caseLawCorpusStatusOptions>["queryFn"]>
  >
>["health"];

/**
 * One word per freshness state. The dot beside it carries the same state as a
 * tone, never on its own: colour is the second reading of the word, not the
 * only one.
 */
const CASE_LAW_HEALTH_LABEL_KEYS = {
  current: "caseLaw.coverage.healthCurrent",
  delayed: "caseLaw.coverage.healthDelayed",
  disabled: "caseLaw.coverage.healthDisabled",
  stalled: "caseLaw.coverage.healthStalled",
  unknown: "caseLaw.coverage.healthUnknown",
} as const satisfies Record<CaseLawHealth, TranslationKey>;

/**
 * `disabled` and `unknown` are neutral on purpose: a source switched off on
 * purpose, and one that has never run, are not faults and must not read as
 * one beside a court that genuinely stopped answering.
 */
const CASE_LAW_HEALTH_TONES = {
  current: "success",
  delayed: "warning",
  disabled: "neutral",
  stalled: "destructive",
  unknown: "neutral",
} as const satisfies Record<CaseLawHealth, ReviewStatusTone>;

/** Freshness as a word, with the dot as its second reading and never its only one. */
export const CaseLawHealthSignal = ({
  className,
  health,
}: {
  className?: string;
  health: CaseLawHealth;
}) => {
  const t = useTranslations();

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap",
        className,
      )}
    >
      <ReviewStatusDot tone={CASE_LAW_HEALTH_TONES[health]} />
      {t(CASE_LAW_HEALTH_LABEL_KEYS[health])}
    </span>
  );
};

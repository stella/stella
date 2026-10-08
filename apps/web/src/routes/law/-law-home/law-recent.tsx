import { useState } from "react";

import { useTranslations } from "use-intl";

import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import { Button } from "@stll/ui/button";
import {
  BookTextIcon,
  FileTextIcon,
  HistoryIcon,
  SearchIcon,
  XIcon,
} from "@stll/ui/icons";
import {
  LANDING_ROW_CLASS,
  LANDING_SECTION_HEADING_CLASS,
  LandingEmpty,
  LandingItemText,
  LandingSection,
} from "@stll/ui/landing";
import { cn } from "@stll/ui/utils";

import { useRelativeTime } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import {
  clearLawRecent,
  filterLawRecent,
  lawRecentKey,
  removeLawRecent,
  useLawRecent,
  type LawRecentEntry,
  type LawRecentFilter,
} from "@/lib/law-search-history";

const FILTER_OPTIONS = {
  all: { value: "all", labelKey: "common.all" },
  search: { value: "search", labelKey: "lawHome.recentSearchFilter" },
  decision: { value: "decision", labelKey: "lawHome.recentCasesFilter" },
  statute: { value: "statute", labelKey: "statutes.title" },
} as const satisfies {
  [Kind in LawRecentFilter]: { value: Kind; labelKey: TranslationKey };
};

const ENTRY_ICONS = {
  search: SearchIcon,
  decision: FileTextIcon,
  statute: BookTextIcon,
} as const satisfies Record<LawRecentEntry["kind"], typeof SearchIcon>;

type LawRecentProps = {
  onSearch: (query: string) => void;
};

export const LawRecent = ({ onSearch }: LawRecentProps) => {
  const t = useTranslations();
  const relativeTime = useRelativeTime();
  const entries = useLawRecent();
  const [filter, setFilter] = useState<LawRecentFilter>("all");
  const visibleEntries = filterLawRecent(entries, filter);

  return (
    <LandingSection
      heading={
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <span className={LANDING_SECTION_HEADING_CLASS}>
              <HistoryIcon className="size-4" />
              {t("lawHome.recent")}
            </span>
            {entries.length > 0 && (
              <Button onClick={clearLawRecent} size="xs" variant="ghost">
                {t("lawHome.clearRecent")}
              </Button>
            )}
          </div>
          <div
            aria-label={t("common.filter")}
            className="flex flex-wrap gap-1 px-2"
            role="group"
          >
            {Object.values(FILTER_OPTIONS).map(({ value, labelKey }) => (
              <Button
                aria-pressed={filter === value}
                key={value}
                onClick={() => setFilter(value)}
                size="xs"
                variant={filter === value ? "secondary" : "ghost"}
              >
                {t(labelKey)}
              </Button>
            ))}
          </div>
        </div>
      }
    >
      {visibleEntries.length === 0 ? (
        <LandingEmpty>{t("lawHome.noRecent")}</LandingEmpty>
      ) : (
        visibleEntries.map((entry) => {
          const Icon = ENTRY_ICONS[entry.kind];
          const title = entry.kind === "search" ? entry.query : entry.title;
          const text = (
            <LandingItemText
              icon={<Icon className="size-4" />}
              meta={relativeTime(entry.at)}
              title={title}
            />
          );
          return (
            <div
              className="group flex min-w-0 items-center gap-1"
              key={lawRecentKey(entry)}
            >
              {entry.kind === "search" ? (
                <button
                  className={cn(LANDING_ROW_CLASS, "min-w-0 flex-1")}
                  onClick={() => onSearch(entry.query)}
                  type="button"
                >
                  {text}
                </button>
              ) : (
                <a
                  className={cn(LANDING_ROW_CLASS, "min-w-0 flex-1")}
                  href={sanitizeHref(entry.path)}
                >
                  {text}
                </a>
              )}
              <Button
                aria-label={t("common.remove")}
                onClick={() => removeLawRecent(entry)}
                size="icon-xs"
                variant="ghost"
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          );
        })
      )}
    </LandingSection>
  );
};

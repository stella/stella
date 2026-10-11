import { useState } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { sanitizeHref } from "@stll/decision-reader/sanitize-href";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose,
} from "@stll/ui/alert-dialog";
import { Button } from "@stll/ui/button";
import { HistoryIcon, SearchIcon, XIcon } from "@stll/ui/icons";
import {
  LANDING_ROW_CLASS,
  LANDING_SECTION_HEADING_CLASS,
  LandingEmpty,
  LandingItemText,
  LandingSection,
} from "@stll/ui/landing";
import { cn } from "@stll/ui/utils";

import { useLawHistory } from "@/features/law-search-history/law-search-history-query";
import { useRelativeTime } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { detached } from "@/lib/detached";
import type { LawRecentFilter } from "@/lib/law-search-history/law-search-history.logic";

import { DocumentIdentityBadge } from "./document-identity-badge";

const FILTER_OPTIONS = {
  all: { value: "all", labelKey: "common.all" },
  search: { value: "search", labelKey: "lawHome.recentSearchFilter" },
  decision: { value: "decision", labelKey: "lawHome.recentCasesFilter" },
  statute: { value: "statute", labelKey: "statutes.title" },
} as const satisfies {
  [Kind in LawRecentFilter]: { value: Kind; labelKey: TranslationKey };
};

type HistoryEntry = Extract<
  ReturnType<typeof useLawHistory>["list"],
  { status: "ready" }
>["entries"][number];
const recentEntryIcon = (entry: HistoryEntry) => {
  switch (entry.kind) {
    case "search":
      return <SearchIcon className="size-4" />;
    case "statute":
    case "decision":
      return <DocumentIdentityBadge identity={entry.documentIdentity} />;
    default:
      entry satisfies never;
      return panic("Unhandled law history kind");
  }
};

type LawRecentProps = {
  onSearch: (query: string) => void;
};

export const LawRecent = ({ onSearch }: LawRecentProps) => {
  const [filter, setFilter] = useState<LawRecentFilter>("all");
  const history = useLawHistory(filter);
  return (
    <LawRecentList
      onSearch={onSearch}
      history={history}
      filter={filter}
      onFilterChange={setFilter}
    />
  );
};

type LawRecentListProps = LawRecentProps & {
  filter: LawRecentFilter;
  onFilterChange: (filter: LawRecentFilter) => void;
  history: Pick<
    ReturnType<typeof useLawHistory>,
    "list" | "importStatus" | "scope" | "remove" | "clear"
  >;
};

export const LawRecentList = (props: LawRecentListProps) => {
  const scopeKey =
    props.history.scope === null
      ? "visitor"
      : JSON.stringify([
          props.history.scope.userId,
          props.history.scope.organizationId,
        ]);
  return <ScopedLawRecentList key={scopeKey} {...props} />;
};

const ScopedLawRecentList = ({
  onSearch,
  history,
  filter,
  onFilterChange,
}: LawRecentListProps) => {
  const t = useTranslations();
  const relativeTime = useRelativeTime();
  const entries = history.list.status === "ready" ? history.list.entries : [];
  const [clearScope, setClearScope] = useState<NonNullable<
    ReturnType<typeof useLawHistory>["scope"]
  > | null>(null);
  const emptyLabel = (() => {
    switch (history.list.status) {
      case "error":
        return "common.error" as const;
      case "pending":
        return "common.loading" as const;
      case "ready":
        return entries.length === 0 ? ("lawHome.noRecent" as const) : undefined;
      default:
        history.list satisfies never;
        return panic("Unhandled law history list status");
    }
  })();

  return (
    <>
      <LandingSection
        heading={
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className={LANDING_SECTION_HEADING_CLASS}>
                <HistoryIcon className="size-4" />
                {t("lawHome.recent")}
              </span>
              {entries.length > 0 && (
                <Button
                  onClick={() => setClearScope(history.scope)}
                  size="xs"
                  variant="ghost"
                >
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
                  onClick={() => onFilterChange(value)}
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
        {history.importStatus.type === "error" && (
          <div
            className="text-muted-foreground mb-2 flex items-center gap-2 px-2 text-xs"
            role="status"
          >
            <span>{t("lawHome.importFailed")}</span>
            <Button
              onClick={() => {
                if (history.importStatus.type === "error") {
                  detached(
                    history.importStatus.retry(),
                    "law-history.import-retry",
                  );
                }
              }}
              size="xs"
              variant="ghost"
            >
              {t("common.retry")}
            </Button>
          </div>
        )}
        {emptyLabel !== undefined ? (
          <LandingEmpty>{t(emptyLabel)}</LandingEmpty>
        ) : (
          entries.map((entry) => {
            const title = entry.kind === "search" ? entry.query : entry.title;
            const text = (
              <LandingItemText
                icon={recentEntryIcon(entry)}
                meta={relativeTime(entry.lastUsedAt)}
                title={title}
              />
            );
            return (
              <div
                className="group flex min-w-0 items-center gap-1"
                key={entry.id}
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
                  disabled={history.remove.isPending}
                  onClick={() => history.remove.mutate(entry)}
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
      <AlertDialog
        open={clearScope !== null}
        onOpenChange={(open) => setClearScope(open ? history.scope : null)}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("lawHome.clearRecent")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("lawHome.clearRecentConfirmation")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="ghost" />}>
              {t("common.cancel")}
            </AlertDialogClose>
            <Button
              variant="destructive"
              loading={history.clear.isPending}
              onClick={() => {
                if (clearScope === null) {
                  return;
                }
                history.clear.mutate(clearScope, {
                  onSuccess: () => setClearScope(null),
                });
              }}
            >
              {t("common.delete")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
};

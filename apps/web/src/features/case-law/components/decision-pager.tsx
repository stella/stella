import type { ReactNode } from "react";

import { Link } from "@tanstack/react-router";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import {
  DECISION_PAGE_SIZES,
  decisionPageSearchValue,
} from "@/features/case-law/decision-pagination.logic";
import type {
  DecisionPagerModel,
  DecisionPageSize,
} from "@/features/case-law/decision-pagination.logic";

type DecisionPagerProps = {
  /** True while the step forward is fetching the page after the chain. */
  isWalking: boolean;
  model: DecisionPagerModel;
  onPageSizeChange: (pageSize: DecisionPageSize) => void;
  /** Asked for the page after the last one walked; it has no cursor yet. */
  onWalkForward: () => void;
  pageSize: DecisionPageSize;
};

/**
 * Where the reader is in the results and how to move.
 *
 * A page already walked is a real link, so it survives a new tab and a
 * crawler; the page after the chain is a button, because its cursor only
 * exists once the page before it has been fetched.
 */
export const DecisionPager = ({
  isWalking,
  model,
  onPageSizeChange,
  onWalkForward,
  pageSize,
}: DecisionPagerProps) => {
  const t = useTranslations();
  const walkedCount = model.pages.length;

  return (
    <nav
      aria-label={t("caseLaw.pagination.label")}
      className="flex flex-wrap items-center justify-between gap-2"
    >
      <div className="flex flex-wrap items-center gap-1">
        <StepLink
          label={t("common.previous")}
          page={model.previousPage}
          placement="previous"
        />

        <ol className="flex flex-wrap items-center gap-1">
          {model.pages.map((page) => (
            <li key={page}>
              {page === model.currentPage ? (
                <span
                  aria-current="page"
                  className="border-border bg-muted/60 text-foreground inline-flex h-7 min-w-7 items-center justify-center rounded-md border px-1.5 text-xs tabular-nums"
                >
                  {page}
                </span>
              ) : (
                <PageLink
                  className="h-7 min-h-0 min-w-7 px-1.5 text-xs tabular-nums"
                  label={t("caseLaw.pagination.goToPage", {
                    page: String(page),
                  })}
                  page={page}
                >
                  {page}
                </PageLink>
              )}
            </li>
          ))}
        </ol>

        {model.nextPage !== null && model.nextPage > walkedCount ? (
          <Button
            aria-busy={isWalking}
            className="h-7 min-h-0 text-xs"
            disabled={isWalking}
            onClick={onWalkForward}
            size="sm"
            variant="ghost"
          >
            {isWalking ? t("caseLaw.loadingMore") : t("common.next")}
            <ChevronRightIcon
              aria-hidden="true"
              className="size-3.5 rtl:rotate-180"
            />
          </Button>
        ) : (
          <StepLink
            label={t("common.next")}
            page={model.nextPage}
            placement="next"
          />
        )}
      </div>

      <label className="text-muted-foreground flex items-center gap-2 text-xs">
        {t("caseLaw.pagination.perPage")}
        <Select
          onValueChange={(value: string | null) => {
            const next = DECISION_PAGE_SIZES.find(
              (size) => String(size) === value,
            );
            if (next !== undefined) {
              onPageSizeChange(next);
            }
          }}
          value={String(pageSize)}
        >
          <SelectTrigger
            aria-label={t("caseLaw.pagination.perPage")}
            className="h-7 min-h-0 w-auto min-w-16 text-xs"
            size="sm"
          >
            <SelectValue>{String(pageSize)}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {DECISION_PAGE_SIZES.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {String(size)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </label>
    </nav>
  );
};

/**
 * One page of the chain. The search is written as an updater so the rest of
 * the URL — the query, the facets, the size — travels with the reader.
 */
const PageLink = ({
  children,
  className,
  label,
  page,
}: {
  children: ReactNode;
  className: string;
  label: string;
  page: number;
}) => (
  <Button
    className={className}
    render={
      <Link
        aria-label={label}
        search={(previous) => ({
          ...previous,
          page: decisionPageSearchValue(page),
        })}
        to="/law/cases"
      />
    }
    size="sm"
    variant="ghost"
  >
    {children}
  </Button>
);

/** Previous or next, drawn even when there is nowhere to go, so the row holds still. */
const StepLink = ({
  label,
  page,
  placement,
}: {
  label: string;
  page: number | null;
  placement: "previous" | "next";
}) => {
  const icon =
    placement === "previous" ? (
      <ChevronLeftIcon aria-hidden="true" className="size-3.5 rtl:rotate-180" />
    ) : (
      <ChevronRightIcon
        aria-hidden="true"
        className="size-3.5 rtl:rotate-180"
      />
    );
  const body =
    placement === "previous" ? (
      <>
        {icon}
        {label}
      </>
    ) : (
      <>
        {label}
        {icon}
      </>
    );

  if (page === null) {
    return (
      <Button
        className="h-7 min-h-0 text-xs"
        disabled
        size="sm"
        variant="ghost"
      >
        {body}
      </Button>
    );
  }
  return (
    <PageLink className="h-7 min-h-0 text-xs" label={label} page={page}>
      {body}
    </PageLink>
  );
};

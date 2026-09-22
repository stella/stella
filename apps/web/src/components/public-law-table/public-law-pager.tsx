import type { ReactElement, ReactNode } from "react";

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

import { PUBLIC_LAW_PAGE_SIZES } from "@/components/public-law-table/public-law-pagination.logic";
import type {
  PublicLawPagerModel,
  PublicLawPageSize,
} from "@/components/public-law-table/public-law-pagination.logic";

/**
 * The link to one page, as the calling route addresses it: an element with no
 * children, carrying the label as its accessible name. The route writes its
 * own search, so the rest of the URL — the query, the filters, the size —
 * travels with the reader.
 */
export type PublicLawPageLink = (input: {
  label: string;
  page: number;
}) => ReactElement;

type PublicLawPagerProps = {
  /** True while the step forward is fetching the page after the chain. */
  isWalking: boolean;
  model: PublicLawPagerModel;
  onPageSizeChange: (pageSize: PublicLawPageSize) => void;
  /** Asked for the page after the last one walked; it has no cursor yet. */
  onWalkForward: () => void;
  pageLink: PublicLawPageLink;
  pageSize: PublicLawPageSize;
};

/**
 * Where the reader is in the results and how to move.
 *
 * A page already walked is a real link, so it survives a new tab and a
 * crawler; the page after the chain is a button, because its cursor only
 * exists once the page before it has been fetched.
 */
export const PublicLawPager = ({
  isWalking,
  model,
  onPageSizeChange,
  onWalkForward,
  pageLink,
  pageSize,
}: PublicLawPagerProps) => {
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
          pageLink={pageLink}
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
                  className="h-7 min-h-0 min-w-7 px-1.5 tabular-nums"
                  label={t("caseLaw.pagination.goToPage", {
                    page: String(page),
                  })}
                  page={page}
                  pageLink={pageLink}
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
            className="h-7 min-h-0"
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
            pageLink={pageLink}
            placement="next"
          />
        )}
      </div>

      <label className="text-muted-foreground flex items-center gap-2 text-xs">
        {t("caseLaw.pagination.perPage")}
        <Select
          onValueChange={(value: string | null) => {
            const next = PUBLIC_LAW_PAGE_SIZES.find(
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
            className="h-7 min-h-0 w-auto min-w-16"
            size="sm"
          >
            <SelectValue>{String(pageSize)}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {PUBLIC_LAW_PAGE_SIZES.map((size) => (
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

/** One page of the chain, as the route's own link. */
const PageLink = ({
  children,
  className,
  label,
  page,
  pageLink,
}: {
  children: ReactNode;
  className: string;
  label: string;
  page: number;
  pageLink: PublicLawPageLink;
}) => (
  <Button
    className={className}
    render={pageLink({ label, page })}
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
  pageLink,
  placement,
}: {
  label: string;
  page: number | null;
  pageLink: PublicLawPageLink;
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
      <Button className="h-7 min-h-0" disabled size="sm" variant="ghost">
        {body}
      </Button>
    );
  }
  return (
    <PageLink
      className="h-7 min-h-0"
      label={label}
      page={page}
      pageLink={pageLink}
    >
      {body}
    </PageLink>
  );
};

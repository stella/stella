import type { ReactElement, ReactNode } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { SEARCH_TOTAL_TYPE } from "@stll/api-contract/search";
import { Button } from "@stll/ui/button";
import { ChevronLeftIcon, ChevronRightIcon } from "@stll/ui/icons";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";

import { PUBLIC_LAW_PAGE_SIZES } from "@/components/public-law-table/public-law-pagination.logic";
import type {
  PublicLawNumberedPagerModel,
  PublicLawPageCount,
  PublicLawPageItem,
  PublicLawPagerModel,
  PublicLawPageSize,
} from "@/components/public-law-table/public-law-pagination.logic";
import { useFormatter } from "@/i18n/formatting-context";

/**
 * The link to one page, as the calling route addresses it: an element with no
 * children, carrying the label as its accessible name. The route writes its
 * own search, so the rest of the URL — the query, the filters, the size —
 * travels with the reader.
 */
type PublicLawPageLink = (input: {
  label: string;
  page: number;
}) => ReactElement;

/**
 * How the reader moves through the list. A list walked by cursor offers the
 * pages already walked and a step past them; a list addressed by offset
 * numbers its pages from the total, up to the deepest one a request reaches.
 */
type PublicLawPagerNavigation =
  | {
      type: "chain";
      model: PublicLawPagerModel;
      /** True while the step forward is fetching the page after the chain. */
      isWalking: boolean;
      /** Asked for the page after the last one walked; it has no cursor yet. */
      onWalkForward: () => void;
    }
  | { type: "numbered"; model: PublicLawNumberedPagerModel };

type PublicLawPagerProps = {
  navigation: PublicLawPagerNavigation;
  onPageSizeChange: (pageSize: PublicLawPageSize) => void;
  /**
   * Told which page the reader followed a link to, before the route moves,
   * so the page can bring them to its first row once it is drawn.
   */
  onPageRequest: (page: number) => void;
  pageLink: PublicLawPageLink;
  pageSize: PublicLawPageSize;
};

/**
 * Where the reader is in the results and how to move.
 *
 * Every page the pager names is a real link, so it survives a new tab and a
 * crawler. The one exception is the step past a walked chain: its cursor only
 * exists once the page before it has been fetched, so it is a button.
 */
export const PublicLawPager = ({
  navigation,
  onPageRequest,
  onPageSizeChange,
  pageLink,
  pageSize,
}: PublicLawPagerProps) => {
  const t = useTranslations();
  const { model } = navigation;
  const items =
    navigation.type === "chain"
      ? navigation.model.pages.map(
          (page) => ({ type: "page", page }) satisfies PublicLawPageItem,
        )
      : navigation.model.items;

  return (
    <nav
      aria-label={t("caseLaw.pagination.label")}
      className="flex flex-wrap items-center justify-between gap-2"
    >
      <div className="flex flex-wrap items-center gap-1">
        <StepLink
          label={t("common.previous")}
          onPageRequest={onPageRequest}
          page={model.previousPage}
          pageLink={pageLink}
          placement="previous"
        />

        <PageList
          currentPage={model.currentPage}
          items={items}
          onPageRequest={onPageRequest}
          pageLink={pageLink}
        />

        {navigation.type === "chain" &&
        navigation.model.nextPage !== null &&
        navigation.model.nextPage > navigation.model.pages.length ? (
          <Button
            aria-busy={navigation.isWalking}
            className="h-7 min-h-0"
            disabled={navigation.isWalking}
            onClick={navigation.onWalkForward}
            size="sm"
            variant="ghost"
          >
            {navigation.isWalking ? t("caseLaw.loadingMore") : t("common.next")}
            <ChevronRightIcon
              aria-hidden="true"
              className="size-3.5 rtl:rotate-180"
            />
          </Button>
        ) : (
          <StepLink
            label={t("common.next")}
            onPageRequest={onPageRequest}
            page={model.nextPage}
            pageLink={pageLink}
            placement="next"
          />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {navigation.type === "numbered" ? (
          <PagePosition
            currentPage={navigation.model.currentPage}
            pageCount={navigation.model.pageCount}
          />
        ) : null}
        {navigation.type === "numbered" && navigation.model.beyondReach ? (
          <p className="text-muted-foreground text-xs">
            {t("caseLaw.pagination.refineForMore")}
          </p>
        ) : null}
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
      </div>
    </nav>
  );
};

/** The numbered pages, the current one marked rather than linked. */
const PageList = ({
  currentPage,
  items,
  onPageRequest,
  pageLink,
}: {
  currentPage: number;
  items: readonly PublicLawPageItem[];
  onPageRequest: (page: number) => void;
  pageLink: PublicLawPageLink;
}) => {
  const t = useTranslations();
  const format = useFormatter();

  if (items.length === 0) {
    return null;
  }
  return (
    <ol className="flex flex-wrap items-center gap-1">
      {items.map((item) => {
        switch (item.type) {
          case "gap":
            return (
              // The pages it stands for are one step from the numbers beside
              // it; a screen reader moves through those numbers instead.
              <li
                aria-hidden="true"
                className="text-muted-foreground inline-flex h-7 min-w-5 items-center justify-center text-xs"
                key={`gap-${String(item.after)}`}
              >
                …
              </li>
            );
          case "page":
            return (
              <li key={item.page}>
                {item.page === currentPage ? (
                  <span
                    aria-current="page"
                    className="border-border bg-muted/60 text-foreground inline-flex h-7 min-w-7 items-center justify-center rounded-md border px-1.5 text-xs tabular-nums"
                  >
                    {format.number(item.page)}
                  </span>
                ) : (
                  <PageLink
                    className="h-7 min-h-0 min-w-7 px-1.5 tabular-nums"
                    label={t("caseLaw.pagination.goToPage", {
                      page: format.number(item.page),
                    })}
                    onPageRequest={onPageRequest}
                    page={item.page}
                    pageLink={pageLink}
                  >
                    {format.number(item.page)}
                  </PageLink>
                )}
              </li>
            );
          default:
            item satisfies never;
            return panic("Unhandled pager item");
        }
      })}
    </ol>
  );
};

/**
 * Which page of how many. An estimated count is drawn with `~` and read out
 * as approximate, so neither the eye nor a screen reader takes it as exact.
 */
const PagePosition = ({
  currentPage,
  pageCount,
}: {
  currentPage: number;
  pageCount: PublicLawPageCount;
}) => {
  const t = useTranslations();
  const format = useFormatter();

  if (pageCount.type === "not_counted") {
    return null;
  }
  const values = {
    page: format.number(currentPage),
    pageCount: format.number(pageCount.pages),
  };
  switch (pageCount.precision) {
    case SEARCH_TOTAL_TYPE.EXACT:
      return (
        <p className="text-muted-foreground text-xs tabular-nums">
          {t("caseLaw.pagination.pageOfCount", values)}
        </p>
      );
    case SEARCH_TOTAL_TYPE.ESTIMATE:
      return (
        <p className="text-muted-foreground text-xs tabular-nums">
          <span aria-hidden="true">
            {t("caseLaw.pagination.pageOfEstimatedCount", values)}
          </span>
          <span className="sr-only">
            {t("caseLaw.pagination.pageOfEstimatedCountLabel", values)}
          </span>
        </p>
      );
    default:
      pageCount.precision satisfies never;
      return panic("Unhandled page count precision");
  }
};

/** One page, as the route's own link. */
const PageLink = ({
  children,
  className,
  label,
  onPageRequest,
  page,
  pageLink,
}: {
  children: ReactNode;
  className: string;
  label: string;
  onPageRequest: (page: number) => void;
  page: number;
  pageLink: PublicLawPageLink;
}) => (
  <Button
    className={className}
    onClick={() => onPageRequest(page)}
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
  onPageRequest,
  page,
  pageLink,
  placement,
}: {
  label: string;
  onPageRequest: (page: number) => void;
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
      onPageRequest={onPageRequest}
      page={page}
      pageLink={pageLink}
    >
      {body}
    </PageLink>
  );
};

import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { ChevronLeftIcon, ChevronRightIcon } from "@stll/ui/icons";
import { Label } from "@stll/ui/label";
import { Skeleton } from "@stll/ui/skeleton";

// The pager's frame and its loading face. A route's pending view draws the
// face; the page's pager is the same frame with live links, so the row under
// the table holds still when the page arrives.

/**
 * Where the reader is in the results and how to move: the steps and pages on
 * one side, where the reader stands and how many rows a page holds on the
 * other.
 */
export const PublicLawPagerFrame = ({
  position,
  steps,
}: {
  position: ReactNode;
  steps: ReactNode;
}) => {
  const t = useTranslations();

  return (
    <nav
      aria-label={t("caseLaw.pagination.label")}
      className="flex flex-wrap items-center justify-between gap-2"
    >
      <div className="flex flex-wrap items-center gap-1">{steps}</div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {position}
      </div>
    </nav>
  );
};

/** Previous or next as it reads: the word with its arrow on the outer side. */
export const PublicLawPagerStepLabel = ({
  label,
  placement,
}: {
  label: string;
  placement: "previous" | "next";
}) =>
  placement === "previous" ? (
    <>
      <ChevronLeftIcon aria-hidden="true" className="size-3.5 rtl:rotate-180" />
      {label}
    </>
  ) : (
    <>
      {label}
      <ChevronRightIcon
        aria-hidden="true"
        className="size-3.5 rtl:rotate-180"
      />
    </>
  );

/** A step with nowhere to go, drawn anyway so the row holds still. */
export const PublicLawPagerStepDisabled = ({
  label,
  placement,
}: {
  label: string;
  placement: "previous" | "next";
}) => (
  <Button className="h-7 min-h-0" disabled size="sm" variant="ghost">
    <PublicLawPagerStepLabel label={label} placement={placement} />
  </Button>
);

/** The page the reader is on, marked rather than linked. */
export const PublicLawCurrentPage = ({ children }: { children: ReactNode }) => (
  <span
    aria-current="page"
    className="border-border bg-muted/60 text-foreground inline-flex h-7 min-w-7 items-center justify-center rounded-md border px-1.5 text-xs tabular-nums"
  >
    {children}
  </span>
);

/** "Per page", around the control that sets it. */
export const PublicLawPageSizeLabel = ({
  children,
  waiting = false,
}: {
  children: ReactNode;
  /** No control to name yet: the caption stands beside its placeholder. */
  waiting?: boolean | undefined;
}) => {
  const t = useTranslations();

  return (
    <Label {...(waiting ? { render: <div /> } : {})} variant="muted">
      {t("caseLaw.pagination.perPage")}
      {children}
    </Label>
  );
};

/**
 * The pager before its page is there. Which page this is and how many rows a
 * page holds live in the address, which only the page reads: those two
 * shimmer, and the steps wait, disabled, where they will be.
 */
export const PublicLawPagerPending = () => {
  const t = useTranslations();

  return (
    <PublicLawPagerFrame
      position={
        <PublicLawPageSizeLabel waiting>
          <Skeleton className="h-7 w-16 rounded-md" />
        </PublicLawPageSizeLabel>
      }
      steps={
        <>
          <PublicLawPagerStepDisabled
            label={t("common.previous")}
            placement="previous"
          />
          <Skeleton className="h-7 w-7 rounded-md" />
          <PublicLawPagerStepDisabled
            label={t("common.next")}
            placement="next"
          />
        </>
      }
    />
  );
};

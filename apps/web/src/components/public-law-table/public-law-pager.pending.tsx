import type { ReactNode } from "react";

import {
  ButtonFace,
  FaceLabelPending,
  SelectTriggerFace,
} from "@stll/ui/control-face";
import { ChevronLeftIcon, ChevronRightIcon } from "@stll/ui/icons";

import { PendingText } from "@/components/pending-text";

// The pager's frame and its loading face. A route's pending view draws the
// face; the page's pager is the same frame with live links, so the row under
// the table holds still when the page arrives.

/**
 * Where the reader is in the results and how to move: the steps and pages on
 * one side, where the reader stands and how many rows a page holds on the
 * other.
 */
export const PublicLawPagerFrame = ({
  label,
  position,
  steps,
}: {
  label?: string | undefined;
  position: ReactNode;
  steps: ReactNode;
}) => (
  <nav
    aria-label={label}
    className="flex flex-wrap items-center justify-between gap-2"
    data-slot="public-law-pager"
  >
    <div className="flex flex-wrap items-center gap-1">{steps}</div>
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {position}
    </div>
  </nav>
);

/** Previous or next as it reads: the word with its arrow on the outer side. */
export const PublicLawPagerStepLabel = ({
  label,
  placement,
}: {
  label: ReactNode;
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

const PUBLIC_LAW_PAGER_STEP_CLASS_NAME = "h-7 min-h-0";

/** The page the reader is on, marked rather than linked. */
export const PublicLawCurrentPage = ({ children }: { children: ReactNode }) => (
  <span
    aria-current="page"
    className="border-border bg-muted/60 text-foreground inline-flex h-7 min-w-7 items-center justify-center rounded-md border px-1.5 text-xs tabular-nums"
  >
    {children}
  </span>
);

const PUBLIC_LAW_PAGE_SIZE_TRIGGER_CLASS_NAME = "h-7 min-h-0 w-auto min-w-16";

/** The pager reserves the current page and the page-size control. */
export const PublicLawPagerPending = () => (
  <PublicLawPagerFrame
    position={
      <div className="text-muted-foreground inline-flex items-center gap-2 text-xs/4 font-medium">
        <PendingText barClassName="w-12" id="caseLaw.pagination.perPage" />
        <SelectTriggerFace
          className={PUBLIC_LAW_PAGE_SIZE_TRIGGER_CLASS_NAME}
          size="sm"
        >
          <FaceLabelPending className="w-4" />
        </SelectTriggerFace>
      </div>
    }
    steps={
      <>
        <ButtonFace
          className={PUBLIC_LAW_PAGER_STEP_CLASS_NAME}
          size="sm"
          variant="ghost"
        >
          <PublicLawPagerStepLabel
            label={<PendingText barClassName="w-12" id="common.previous" />}
            placement="previous"
          />
        </ButtonFace>
        <PublicLawCurrentPage>
          <FaceLabelPending className="w-2" />
        </PublicLawCurrentPage>
        <ButtonFace
          className={PUBLIC_LAW_PAGER_STEP_CLASS_NAME}
          size="sm"
          variant="ghost"
        >
          <PublicLawPagerStepLabel
            label={<PendingText barClassName="w-8" id="common.next" />}
            placement="next"
          />
        </ButtonFace>
      </>
    }
  />
);

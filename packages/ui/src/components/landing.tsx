"use client";

import type { ReactElement, ReactNode } from "react";

import { cn } from "../lib/utils";
import { BidiText } from "./bidi-text";
import { LANDING_ROW_CLASS } from "./landing-shell";
import { TruncatedText } from "./truncated-text";

// The landing's layout, section and pending pieces live in `landing-shell`,
// which a route's pending half can import without the row text below (its
// truncation tooltip is too heavy for the entry chunk).
export {
  LANDING_ROW_CLASS,
  LANDING_SECTION_HEADING_CLASS,
  LandingBoxPending,
  LandingGreeting,
  LandingLayout,
  LandingRowsPending,
  LandingSection,
  LandingSectionHeadingPending,
} from "./landing-shell";
type LandingButtonProps = {
  icon?: ReactElement;
  meta?: ReactNode | undefined;
  onClick: () => void;
  title: ReactNode;
};

export const LandingButton = ({
  icon,
  meta,
  onClick,
  title,
}: LandingButtonProps) => (
  <button className={LANDING_ROW_CLASS} onClick={onClick} type="button">
    <LandingItemText
      {...(icon === undefined ? {} : { icon })}
      meta={meta}
      title={title}
    />
  </button>
);

type LandingItemTextProps = {
  icon?: ReactElement;
  iconTone?: "muted" | "matter" | undefined;
  meta?: ReactNode | undefined;
  title: ReactNode;
};

export const LandingItemText = ({
  icon,
  iconTone = "muted",
  meta,
  title,
}: LandingItemTextProps) => (
  <span className="flex min-w-0 items-start gap-2">
    {icon === undefined ? (
      <span aria-hidden="true" className="size-4 shrink-0" />
    ) : (
      <LandingRowIcon tone={iconTone}>{icon}</LandingRowIcon>
    )}
    <span className="min-w-0 flex-1">
      <TruncatedText
        className="text-foreground text-sm font-medium"
        render={<BidiText as="span" />}
      >
        {title}
      </TruncatedText>
      {meta !== undefined && meta !== null ? (
        <TruncatedText className="text-muted-foreground text-xs">
          {meta}
        </TruncatedText>
      ) : null}
    </span>
  </span>
);

type LandingRowIconProps = {
  children: ReactElement;
  tone?: "muted" | "matter" | undefined;
};

export const LandingRowIcon = ({
  children,
  tone = "muted",
}: LandingRowIconProps) => (
  <span
    className={cn(
      "mt-0.5 flex min-h-4 min-w-4 shrink-0 items-center justify-center",
      tone === "muted" &&
        "text-foreground-muted group-hover:text-muted-foreground",
    )}
  >
    {children}
  </span>
);

type LandingEmptyProps = {
  children: ReactNode;
};

export const LandingEmpty = ({ children }: LandingEmptyProps) => (
  <div className="border-border text-muted-foreground rounded-md border border-dashed px-3 py-3 text-sm">
    {children}
  </div>
);

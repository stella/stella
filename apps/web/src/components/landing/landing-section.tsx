import type { ReactElement, ReactNode } from "react";

import { BidiText } from "@stll/ui/bidi-text";
import { cn } from "@stll/ui/utils";

/**
 * The columns under a home's box: the chat home and the law home share one
 * geometry, so a reader who has learned one has learned the other.
 */

/** A column's heading: an icon and an uppercase label, as a link or a trigger. */
export const LANDING_SECTION_HEADING_CLASS =
  "text-muted-foreground hover:text-foreground focus-visible:ring-ring flex items-center gap-2 rounded-md px-1 text-xs font-semibold tracking-widest uppercase transition-colors outline-none focus-visible:ring-2";

/** A row of a column, as a link or a button. */
export const LANDING_ROW_CLASS =
  "group hover:bg-accent/50 focus-visible:ring-ring rounded-md px-2 py-1.5 text-start transition-colors outline-none focus-visible:ring-2";

type LandingSectionProps = {
  children: ReactNode;
  heading: ReactNode;
};

export const LandingSection = ({ children, heading }: LandingSectionProps) => (
  <section className="min-w-0">
    <div className="mb-3">{heading}</div>
    <div className="flex flex-col gap-1">{children}</div>
  </section>
);

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
    {icon !== undefined && (
      <LandingRowIcon tone={iconTone}>{icon}</LandingRowIcon>
    )}
    <span className="min-w-0 flex-1">
      <BidiText
        as="span"
        className="text-foreground block truncate text-sm font-medium"
      >
        {title}
      </BidiText>
      {meta !== undefined && meta !== null ? (
        <span className="text-muted-foreground block truncate text-xs">
          {meta}
        </span>
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
      "mt-0.5 flex size-4 shrink-0 items-center justify-center transition-colors",
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

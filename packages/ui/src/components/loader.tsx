import type { ComponentProps } from "react";

import { cn } from "../lib/utils";
import { StellaMark } from "./stella-mark";

/**
 * The one indeterminate loading indicator: the Stella mark breathing. Inline
 * (`sm`) next to a control that is busy, `md` in a row, `lg` for a region.
 * Content with a known shape gets a `Skeleton` instead, never a loader.
 */
const Loader = ({
  label,
  variant = "status",
  size = "md",
  className,
  ...props
}: LoaderProps) => (
  <span
    {...props}
    aria-busy={variant === "status" ? true : undefined}
    aria-hidden={variant === "decorative" ? true : undefined}
    aria-label={label}
    className={cn(
      "inline-flex shrink-0 items-center justify-center",
      LOADER_SIZE[size],
      className,
    )}
    data-slot="loader"
    role={variant === "status" ? "status" : undefined}
  >
    <LoaderMark />
  </span>
);

/**
 * A region whose content has no shape yet (a job running, a first fetch): the
 * mark, one line saying what is happening, and at most one line of detail.
 * Progress is stated in the detail text, never drawn as a bar that guesses.
 */
const LoaderState = ({ label, detail, hint, className }: LoaderStateProps) => (
  <div
    aria-busy="true"
    className={cn(
      "flex h-full flex-col items-center justify-center gap-3 px-6 text-center",
      className,
    )}
    data-slot="loader-state"
    role="status"
  >
    <span className={LOADER_SIZE.lg}>
      <LoaderMark />
    </span>
    <div className="space-y-1">
      <p className="text-foreground text-sm font-medium">{label}</p>
      {detail !== undefined && (
        <p className="text-muted-foreground truncate text-xs tabular-nums">
          {detail}
        </p>
      )}
      {hint !== undefined && (
        <p className="text-muted-foreground text-2xs text-pretty">{hint}</p>
      )}
    </div>
  </div>
);

const LOADER_SIZE = {
  sm: "size-4",
  md: "size-6",
  lg: "size-8",
} as const;

type LoaderSize = keyof typeof LOADER_SIZE;

const LoaderMark = () => (
  <StellaMark className="animate-loader text-muted-foreground size-full motion-reduce:animate-none motion-reduce:opacity-70" />
);

type LoaderProps = Omit<
  ComponentProps<"span">,
  "children" | "role" | "aria-label" | "aria-hidden" | "aria-busy"
> & {
  size?: LoaderSize;
} & (
    | {
        variant?: "status";
        /** What is pending, for assistive technology ("Loading matters"). */
        label: string;
      }
    | {
        /** The surrounding control or text announces the pending state. */
        variant: "decorative";
        label?: never;
      }
  );

type LoaderStateProps = {
  /** What is happening, shown as the title and announced. */
  label: string;
  /** A short line under the title: a name, a fraction, a percentage. */
  detail?: string | undefined;
  /** Expectation-setting copy, kept small. */
  hint?: string | undefined;
  className?: string | undefined;
};

export { Loader, LoaderState };

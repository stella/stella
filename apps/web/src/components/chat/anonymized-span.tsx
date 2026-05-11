import type { ComponentProps, ReactNode } from "react";

import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/lib/utils";

import Tooltip from "@/components/tooltip";

type AnonymizedSpanProps = ComponentProps<"button"> & {
  /** Wire-format placeholder the model saw, e.g. `[PERSON_1]`. */
  ph?: string;
  children?: ReactNode;
};

/**
 * Renders text that round-tripped through anonymization as a
 * subtle green pill. The placeholder the model actually saw
 * surfaces in a tooltip on hover / focus / long-press, so the
 * rendered text never swaps under the reader — switching the
 * visible string mid-line used to make the surrounding paragraph
 * reflow and look "split". The HAST node is emitted by the
 * `rehype-anon-spans` plugin.
 */
export const AnonymizedSpan = ({
  ph,
  children,
  className,
  ...rest
}: AnonymizedSpanProps) => {
  const t = useTranslations();

  if (!ph) {
    return (
      <span className={className} {...rest}>
        {children}
      </span>
    );
  }

  const label = t("chat.anonymizedSpan.tooltip", { placeholder: ph });

  // Children are inlined into the `render` element rather than
  // passed as `<Tooltip>{children}</Tooltip>`. The working pattern
  // in `chat-anonymized-toggle.tsx` shows the trigger element owns
  // its own children — passing them alongside `render` can drop
  // them on the floor depending on how Base UI's element-merging
  // resolves the two sources.
  // `<button type="button">` so Base UI's Tooltip.Trigger gets a
  // first-class focusable, hover-aware element to attach to —
  // attaching to a custom `<span tabIndex={0}>` wasn't reliably
  // surfacing the tooltip. `text-left`, `font-inherit`, and the
  // reset rules keep the button reading as inline pill text
  // inside a paragraph. `select-all` keeps double-click as a
  // whole-pill selection rather than a word-boundary split.
  // Native `title` is set as a belt-and-braces fallback in case
  // the styled tooltip is suppressed (e.g. shadow DOM, embedded
  // export views).
  return (
    <Tooltip
      content={label}
      render={
        <button
          aria-label={label}
          className={cn(
            "bg-success/12 text-success hover:bg-success/20 focus-visible:ring-success/50 inline cursor-help appearance-none rounded border-0 bg-clip-padding px-1 align-baseline font-[inherit] leading-[inherit] text-[inherit] transition-colors select-all focus-visible:ring-2 focus-visible:outline-none",
            className,
          )}
          title={label}
          type="button"
          {...rest}
        >
          {children}
        </button>
      }
    />
  );
};

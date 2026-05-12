import type { ComponentProps, ReactNode } from "react";

import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/lib/utils";

import { InlinePill } from "@/components/inline-pill";

type AnonymizedSpanProps = ComponentProps<"button"> & {
  /** Wire-format placeholder the model saw, e.g. `[PERSON_1]`. */
  ph?: string | undefined;
  children?: ReactNode;
  /**
   * When false, render as a styled `<span>` with no tooltip and
   * no focusable button — used when the pill is already inside
   * another interactive element (e.g. an ask-user option
   * `<button>`), where nested buttons break focus/click semantics
   * and produce invalid HTML.
   */
  interactive?: boolean | undefined;
};

/**
 * Renders text that round-tripped through anonymization as a
 * subtle green inline pill. The placeholder the model actually
 * saw surfaces in a tooltip on hover, focus, and long-press; the
 * rendered text never swaps under the reader. `select-all` keeps
 * double-click as a whole-pill selection so the mention doesn't
 * appear to "split" between words. The HAST node is emitted by
 * the `rehype-anon-spans` plugin.
 */
export const AnonymizedSpan = ({
  ph,
  children,
  className,
  interactive = true,
}: AnonymizedSpanProps) => {
  const t = useTranslations();

  if (!ph) {
    return <span className={className}>{children}</span>;
  }

  const label = t("chat.anonymizedSpan.tooltip", { placeholder: ph });

  if (!interactive) {
    // Static, non-focusable rendering for use inside another
    // interactive element. Loses the hover tooltip but keeps the
    // visual pill so the audit cue is still visible.
    return (
      <span
        aria-label={label}
        className={cn(
          "bg-success/12 text-success rounded px-1 align-baseline select-all",
          className,
        )}
        title={label}
      >
        {children}
      </span>
    );
  }

  return (
    <InlinePill
      ariaLabel={label}
      className={cn("align-baseline select-all", className)}
      size="inherit"
      title={label}
      tone="success"
      tooltip={label}
    >
      {children}
    </InlinePill>
  );
};

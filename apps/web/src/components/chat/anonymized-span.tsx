import type { ComponentProps, ReactNode } from "react";

import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/lib/utils";

import { InlinePill } from "@/components/inline-pill";

type AnonymizedSpanProps = ComponentProps<"button"> & {
  /** Wire-format placeholder the model saw, e.g. `[PERSON_1]`. */
  ph?: string;
  children?: ReactNode;
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
}: AnonymizedSpanProps) => {
  const t = useTranslations();

  if (!ph) {
    return <span className={className}>{children}</span>;
  }

  const label = t("chat.anonymizedSpan.tooltip", { placeholder: ph });

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

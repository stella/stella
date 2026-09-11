import type { ReactNode } from "react";

import { cn } from "@stll/ui/utils";

import { sanitizeHref } from "@/lib/sanitize-href";

export const LEGAL_CITATION_LINK_CLASS_NAME =
  "text-primary decoration-primary/40 underline underline-offset-2 hover:decoration-current";

/** A legal reference whose target lives outside Stella's corpus. */
export const ExternalCitationLink = ({
  children,
  className,
  href,
}: {
  children: ReactNode;
  className?: string | undefined;
  href: string;
}) => (
  <a
    className={cn(LEGAL_CITATION_LINK_CLASS_NAME, className)}
    href={sanitizeHref(href)}
    rel="noreferrer"
    target="_blank"
  >
    {children}
  </a>
);

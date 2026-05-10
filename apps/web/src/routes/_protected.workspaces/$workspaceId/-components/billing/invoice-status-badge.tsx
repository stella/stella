import { useTranslations } from "use-intl";

import { cn } from "@stll/ui/lib/utils";

import type { InvoiceStatus } from "@/routes/_protected.workspaces/$workspaceId/-queries/invoices";

const INVOICE_STATUS_STYLES = {
  draft: "bg-muted text-muted-foreground",
  finalized: "bg-[var(--option-blue-bg)] text-[var(--option-blue-fg)]",
  sent: "bg-[var(--option-amber-bg)] text-[var(--option-amber-fg)]",
  paid: "bg-[var(--option-emerald-bg)] text-[var(--option-emerald-fg)]",
  void: "bg-[var(--option-red-bg)] text-[var(--option-red-fg)]",
} as const satisfies Record<InvoiceStatus, string>;

type InvoiceStatusBadgeProps = {
  status: InvoiceStatus;
  className?: string;
};

export const InvoiceStatusBadge = ({
  status,
  className,
}: InvoiceStatusBadgeProps) => {
  const t = useTranslations("billing.invoices.statuses");

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium",
        INVOICE_STATUS_STYLES[status],
        className,
      )}
    >
      {t(status)}
    </span>
  );
};

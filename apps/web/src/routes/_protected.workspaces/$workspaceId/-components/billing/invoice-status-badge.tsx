import { useTranslations } from "use-intl";

import { cn } from "@stella/ui/lib/utils";

import type { InvoiceStatus } from "@/routes/_protected.workspaces/$workspaceId/-queries/invoices";

const INVOICE_STATUS_STYLES: Record<InvoiceStatus, string> = {
  draft: "bg-muted text-muted-foreground",
  finalized: "bg-blue-500/10 text-blue-700 dark:text-blue-400",
  sent: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  paid: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  void: "bg-red-500/10 text-red-700 dark:text-red-400",
};

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

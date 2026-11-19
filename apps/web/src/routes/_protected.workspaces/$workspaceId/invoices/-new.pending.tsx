import type { ReactNode } from "react";

import { useTranslations } from "use-intl";

import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ArrowLeftIcon } from "@stll/ui/icons";
import { Skeleton } from "@stll/ui/skeleton";

/**
 * The invoice composer's frame: the way back to the matter's invoices beside
 * the title, over the composer. The page puts the link in `back`; the pending
 * view shows the same arrow, inert, until the page is there.
 */
export const NewInvoiceShell = ({
  back,
  children,
}: {
  back: ReactNode;
  children: ReactNode;
}) => {
  const t = useTranslations();
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        {back}
        <h1 className="text-sm font-medium">
          {t("billing.invoiceComposer.title")}
        </h1>
      </div>
      {children}
    </div>
  );
};

/** The back arrow, sized like the icon button the page puts in its place. */
export const NewInvoiceBackIcon = () => (
  <DirectionalIcon className="size-4" icon={ArrowLeftIcon} />
);

export const NewInvoicePending = () => (
  <NewInvoiceShell
    back={
      <span
        aria-hidden="true"
        className="inline-flex size-9 shrink-0 items-center justify-center sm:size-8"
      >
        <NewInvoiceBackIcon />
      </span>
    }
  >
    <div className="flex flex-col gap-4 p-4 sm:p-6">
      <div className="flex gap-2">
        <Skeleton className="h-7 w-20 rounded-full" />
        <Skeleton className="h-7 w-20 rounded-full" />
        <Skeleton className="h-7 w-20 rounded-full" />
      </div>
      <Skeleton className="h-64 w-full rounded-2xl" />
      <Skeleton className="h-24 w-full rounded-2xl" />
    </div>
  </NewInvoiceShell>
);

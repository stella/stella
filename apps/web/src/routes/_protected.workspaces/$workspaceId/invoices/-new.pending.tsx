import type { ReactNode } from "react";

import { ButtonFace } from "@stll/ui/control-face";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { ArrowLeftIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";

import { InvoiceComposerSkeleton } from "@/components/billing/invoice-composer.pending";
import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";

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
}) => (
  <div className="flex h-full flex-col">
    <div className="flex items-center gap-3 border-b px-4 py-3">
      {back}
      <h1 className="text-sm font-medium">
        <PendingText id="billing.invoiceComposer.title" />
      </h1>
    </div>
    {children}
  </div>
);

/** The back arrow, sized like the icon button the page puts in its place. */
export const NewInvoiceBackIcon = () => (
  <DirectionalIcon className="size-4" icon={ArrowLeftIcon} />
);

export const NewInvoicePending = framePendingView(() => (
  <NewInvoiceShell
    back={
      <ButtonFace size="icon" variant="ghost">
        <NewInvoiceBackIcon />
      </ButtonFace>
    }
  >
    <ScrollArea className="flex-1">
      <InvoiceComposerSkeleton />
    </ScrollArea>
  </NewInvoiceShell>
));

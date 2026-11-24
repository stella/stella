import type { PropsWithChildren, ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { DetailsGrid, DetailsItem } from "@stll/ui/details-grid";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/frame";
import { DownloadIcon } from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";

/** The page's column, around the invoice or the reason it did not open. */
export const InvoiceLinkShell = ({ children }: PropsWithChildren) => (
  <div className="flex min-h-full flex-1 justify-center px-4 py-10">
    <div className="w-full max-w-xl">{children}</div>
  </div>
);

type InvoiceSummaryShapeProps = {
  header: ReactNode;
  /** The buyer, the invoice's facts and what is due. */
  facts: ReactNode;
  files: ReactNode;
  expiry: ReactNode;
};

/** The invoice card: who issued it, its facts, its files and the link's expiry. */
export const InvoiceSummaryShape = ({
  expiry,
  facts,
  files,
  header,
}: InvoiceSummaryShapeProps) => (
  <Frame>
    <FrameHeader>{header}</FrameHeader>
    <FramePanel className="flex flex-col gap-5">
      {facts}
      <div className="flex flex-wrap gap-2">{files}</div>
      <p className="text-muted-foreground text-xs">{expiry}</p>
    </FramePanel>
  </Frame>
);

type InvoiceFactProps = {
  label: string;
  value: string;
  /** The amount due closes the totals in bold. */
  emphasis: "amount-due" | "none";
};

/** One fact of the invoice (its number, a date, a total). */
export const InvoiceFact = ({ emphasis, label, value }: InvoiceFactProps) => (
  <DetailsItem
    label={
      emphasis === "amount-due" ? (
        <span className="font-semibold">{label}</span>
      ) : (
        label
      )
    }
  >
    <span
      className={cn(
        "tabular-nums",
        emphasis === "amount-due" && "font-semibold",
      )}
    >
      {value}
    </span>
  </DetailsItem>
);

const InvoiceFactPending = () => (
  <DetailsItem label={<FaceLabelPending className="w-16" />}>
    <FaceLabelPending className="w-24" />
  </DetailsItem>
);

// Issue, due and supply dates, then net, VAT and the total: the facts an
// issued invoice states.
const PENDING_FACT_KEYS = ["issue", "due", "supply", "net", "vat", "total"];

const InvoiceFactsPending = () => (
  <div className="flex flex-col gap-4">
    <p className="text-sm">
      <FaceLabelPending className="w-40" />
    </p>
    <DetailsGrid>
      {PENDING_FACT_KEYS.map((key) => (
        <InvoiceFactPending key={key} />
      ))}
    </DetailsGrid>
  </div>
);

/** The invoice card before the link's read has answered. */
export const InvoiceSummaryPending = () => (
  <InvoiceSummaryShape
    expiry={<FaceLabelPending className="w-48" />}
    facts={<InvoiceFactsPending />}
    files={
      // The PDF is always there; an e-invoice joins it only when one exists.
      <ButtonFace size="default" variant="default">
        <DownloadIcon className="size-4" />
        <PendingText barClassName="w-24" id="templates.downloadPdf" />
      </ButtonFace>
    }
    header={
      <div>
        <FrameTitle>
          <FaceLabelPending className="w-48" />
        </FrameTitle>
        <FrameDescription>
          <FaceLabelPending className="w-32" />
        </FrameDescription>
      </div>
    }
  />
);

export const InvoiceLinkPending = framePendingView(() => (
  <InvoiceLinkShell>
    <InvoiceSummaryPending />
  </InvoiceLinkShell>
));

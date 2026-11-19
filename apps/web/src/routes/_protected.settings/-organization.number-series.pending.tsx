import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { CalendarIcon } from "@stll/ui/icons";

import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";

import {
  BillingSettingsFrame,
  BillingSettingsTable,
} from "./organization/-components/organization/billing-settings-table.pending";
import type { BillingSettingsColumn } from "./organization/-components/organization/billing-settings-table.pending";

export const NUMBER_SERIES_COLUMNS = [
  { id: "name", label: "billing.numberSeries.name", bar: "w-24" },
  {
    id: "documentType",
    label: "billing.numberSeries.documentType",
    bar: "w-20",
  },
  { id: "pattern", label: "billing.numberSeries.pattern", bar: "w-20" },
  { id: "preview", label: "billing.numberSeries.preview", bar: "w-20" },
  { id: "actions", label: "common.actions", bar: "w-28" },
] as const satisfies readonly BillingSettingsColumn[];

export const NumberSeriesSettingsShell = ({
  children,
}: {
  children: ReactNode;
}) => (
  <>
    <SettingsPageHeader
      title={<PendingText id="billing.numberSeries.title" />}
    />
    {children}
  </>
);

export const NumberSeriesCardShell = ({
  action,
  dateField,
  children,
}: {
  action: ReactNode;
  dateField: ReactNode;
  children: ReactNode;
}) => (
  <BillingSettingsFrame
    actions={action}
    controls={
      <>
        <div className="flex flex-col gap-1.5">{dateField}</div>
        <p className="text-muted-foreground text-sm">
          <PendingText
            barClassName="w-72"
            id="billing.numberSeries.previewHelp"
          />
        </p>
      </>
    }
    description="billing.numberSeries.description"
  >
    {children}
  </BillingSettingsFrame>
);

export const NumberSeriesSettingsPending = framePendingView(() => (
  <NumberSeriesSettingsShell>
    <NumberSeriesCardShell
      action={
        <ButtonFace size="default" variant="default">
          <PendingText id="billing.numberSeries.add" />
        </ButtonFace>
      }
      dateField={
        <>
          <span className="text-foreground text-base/4.5 font-medium sm:text-sm/4">
            <PendingText id="billing.numberSeries.issueDate" />
          </span>
          <span
            aria-hidden="true"
            className="flex min-h-7 items-center gap-1.5 rounded-md px-1.5 text-sm opacity-64"
          >
            <CalendarIcon className="size-3.5 shrink-0" />
            <FaceLabelPending className="w-20" />
          </span>
        </>
      }
    >
      <BillingSettingsTable
        columns={NUMBER_SERIES_COLUMNS}
        rows={{ type: "pending" }}
      />
    </NumberSeriesCardShell>
  </NumberSeriesSettingsShell>
));

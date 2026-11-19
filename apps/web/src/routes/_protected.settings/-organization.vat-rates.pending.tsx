import type { ReactNode } from "react";

import { ButtonFace } from "@stll/ui/control-face";

import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header";

import {
  BillingSettingsFrame,
  BillingSettingsTable,
} from "./organization/-components/organization/billing-settings-table.pending";
import type { BillingSettingsColumn } from "./organization/-components/organization/billing-settings-table.pending";

export const VAT_RATE_COLUMNS = [
  {
    id: "code",
    label: "billing.vatRates.code",
    bar: "w-16",
    className: "max-sm:hidden",
  },
  { id: "name", label: "billing.vatRates.name", bar: "w-28" },
  { id: "rate", label: "billing.vatRates.rate", bar: "w-12" },
  {
    id: "from",
    label: "billing.vatRates.validFrom",
    bar: "w-20",
    className: "max-sm:hidden",
  },
  {
    id: "to",
    label: "billing.vatRates.validTo",
    bar: "w-20",
    className: "max-sm:hidden",
  },
  { id: "actions", label: "common.actions", bar: "w-20" },
] as const satisfies readonly BillingSettingsColumn[];

export const VatRateSettingsShell = ({ children }: { children: ReactNode }) => (
  <>
    <SettingsPageHeader title={<PendingText id="billing.vatRates.title" />} />
    {children}
  </>
);

export const VatRatesCardShell = ({
  actions,
  children,
}: {
  actions: ReactNode;
  children: ReactNode;
}) => (
  <BillingSettingsFrame
    actions={<div className="flex flex-wrap gap-2">{actions}</div>}
    description="billing.vatRates.description"
  >
    {children}
  </BillingSettingsFrame>
);

export const VatRateSettingsPending = framePendingView(() => (
  <VatRateSettingsShell>
    <VatRatesCardShell
      actions={
        <>
          <ButtonFace size="default" variant="outline">
            <PendingText id="billing.vatRates.addSlovakia" />
          </ButtonFace>
          <ButtonFace size="default" variant="outline">
            <PendingText id="billing.vatRates.addCzechia" />
          </ButtonFace>
          <ButtonFace size="default" variant="default">
            <PendingText id="billing.vatRates.add" />
          </ButtonFace>
        </>
      }
    >
      <BillingSettingsTable
        columns={VAT_RATE_COLUMNS}
        rows={{ type: "pending", rowClassName: "max-sm:h-30" }}
      />
    </VatRatesCardShell>
  </VatRateSettingsShell>
));

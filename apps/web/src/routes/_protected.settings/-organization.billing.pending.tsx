import type { ReactNode } from "react";

import { ButtonFace } from "@stll/ui/control-face";

import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header.pending";
import { SettingsPagePending } from "@/routes/_protected.settings/-components/settings-shell/settings-shell.pending";

import {
  BillingSettingsFrame,
  BillingSettingsTable,
} from "./organization/-components/organization/billing-settings-table.pending";
import type { BillingSettingsColumn } from "./organization/-components/organization/billing-settings-table.pending";

export const SELLER_PROFILE_COLUMNS = [
  { id: "name", label: "billing.sellerProfiles.legalName", bar: "w-32" },
  {
    id: "currency",
    label: "billing.sellerProfiles.defaultCurrency",
    bar: "w-12",
  },
  { id: "actions", label: "common.actions", bar: "w-28" },
] as const satisfies readonly BillingSettingsColumn[];

export const BillingSettingsShell = ({ children }: { children: ReactNode }) => (
  <>
    <SettingsPageHeader title={<PendingText id="billing.settingsTitle" />} />
    {children}
  </>
);

export const SellerProfilesCardShell = ({
  action,
  children,
}: {
  action: ReactNode;
  children: ReactNode;
}) => (
  <BillingSettingsFrame
    actions={action}
    description="billing.sellerProfiles.description"
    heading="billing.sellerProfiles.title"
  >
    {children}
  </BillingSettingsFrame>
);

export const BillingSettingsPending = framePendingView(() => (
  <SettingsPagePending area="organization">
    <BillingSettingsShell>
      <SellerProfilesCardShell
        action={
          <ButtonFace size="default" variant="default">
            <PendingText id="billing.sellerProfiles.add" />
          </ButtonFace>
        }
      >
        <BillingSettingsTable
          columns={SELLER_PROFILE_COLUMNS}
          rows={{ type: "pending" }}
        />
      </SellerProfilesCardShell>
    </BillingSettingsShell>
  </SettingsPagePending>
));

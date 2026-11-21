import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { SettingsRow } from "@stll/ui/settings";

import { PendingText } from "@/components/pending-text";
import { SettingsSectionPending } from "@/routes/_protected.settings/-components/settings-section.pending";

export function UsagePlanSection({
  kind,
  children,
}: {
  kind: "subscription" | "addon";
  children: ReactNode;
}) {
  return (
    <SettingsSectionPending
      description={
        kind === "subscription"
          ? "settings.organization.usagePlansDescription"
          : "settings.organization.usagePacksDescription"
      }
      title={
        kind === "subscription"
          ? "settings.organization.usagePlansTitle"
          : "settings.organization.usagePacksTitle"
      }
    >
      {children}
    </SettingsSectionPending>
  );
}

/** One plan: its name, its description and price under it, then its
 *  purchase controls. */
export function UsagePlanRowFace({
  actions,
  description,
  offerLine,
  title,
}: {
  title: ReactNode;
  description?: ReactNode;
  offerLine?: ReactNode;
  actions: ReactNode;
}) {
  return (
    <SettingsRow
      description={
        <>
          {description !== undefined && (
            <span className="block">{description}</span>
          )}
          {offerLine !== undefined && (
            <span className="block">{offerLine}</span>
          )}
        </>
      }
      title={title}
    >
      {actions}
    </SettingsRow>
  );
}

function PlanRowPending() {
  return (
    <UsagePlanRowFace
      actions={
        <ButtonFace size="default" variant="default">
          <PendingText
            barClassName="w-20"
            id="settings.organization.usagePlanCheckout"
          />
        </ButtonFace>
      }
      description={<FaceLabelPending className="w-48" />}
      offerLine={<FaceLabelPending className="w-24" />}
      title={<FaceLabelPending className="w-36" />}
    />
  );
}

export function UsagePlansPending() {
  return (
    <UsagePlanSection kind="subscription">
      <PlanRowPending />
      <PlanRowPending />
    </UsagePlanSection>
  );
}

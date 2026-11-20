import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { Frame, FramePanel } from "@stll/ui/frame";

import { PendingText } from "@/components/pending-text";
import { env } from "@/env";
import { framePendingView } from "@/routes/-pending-view.logic";
import { SettingsPageHeader } from "@/routes/_protected.settings/-components/settings-page-header.pending";
import { SettingsPagePending } from "@/routes/_protected.settings/-components/settings-shell/settings-shell.pending";
import { UsagePlansPending } from "@/routes/_protected.settings/organization/-components/organization/usage-plans-card.pending";

export function UsageShell({
  children,
  plans,
}: {
  children: ReactNode;
  plans: ReactNode;
}) {
  return (
    <>
      <SettingsPageHeader
        description={
          <PendingText
            barClassName="w-72 max-w-full"
            id="settings.organization.usageDescription"
          />
        }
        title={
          <PendingText barClassName="w-32" id="settings.organization.usage" />
        }
      />
      {children}
      <div className="mt-6 space-y-6">{plans}</div>
    </>
  );
}

export function ActiveEntitlementCardFace({
  title,
  summary,
  action,
  remainingUsage,
  formattedUsage,
}: {
  title: ReactNode;
  summary: ReactNode;
  action: ReactNode;
  remainingUsage: ReactNode;
  formattedUsage: ReactNode;
}) {
  return (
    <Frame>
      <FramePanel>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-lg font-medium">{title}</h2>
            <p className="text-muted-foreground text-sm">{summary}</p>
          </div>
          {action}
        </div>
        <div className="mt-6 space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">
              <PendingText
                barClassName="w-36"
                id="settings.organization.usageUnitsThisPeriod"
              />
            </span>
            <span className="font-medium">{remainingUsage}</span>
          </div>
          <p className="text-muted-foreground text-sm tabular-nums">
            {formattedUsage}
          </p>
        </div>
      </FramePanel>
    </Frame>
  );
}

export function EntitlementPending() {
  return (
    <ActiveEntitlementCardFace
      action={
        <ButtonFace size="default" variant="ghost">
          <PendingText
            barClassName="w-16"
            id="settings.organization.usageManage"
          />
        </ButtonFace>
      }
      remainingUsage={<FaceLabelPending className="w-24" />}
      formattedUsage={<FaceLabelPending className="w-12" />}
      summary={<FaceLabelPending className="w-72 max-w-full" />}
      title={<FaceLabelPending className="w-40" />}
    />
  );
}

export const UsagePending = framePendingView(() =>
  env.VITE_FEATURE_USAGE ? (
    <SettingsPagePending>
      <UsageShell plans={<UsagePlansPending />}>
        <EntitlementPending />
      </UsageShell>
    </SettingsPagePending>
  ) : null,
);

import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { Frame, FramePanel } from "@stll/ui/frame";

import { PendingText } from "@/components/pending-text";

export function UsagePlanSection({
  kind,
  children,
}: {
  kind: "subscription" | "addon";
  children: ReactNode;
}) {
  return (
    <Frame>
      <FramePanel>
        <h2 className="text-lg font-medium">
          <PendingText
            barClassName="w-32"
            id={
              kind === "subscription"
                ? "settings.organization.usagePlansTitle"
                : "settings.organization.usagePacksTitle"
            }
          />
        </h2>
        <p className="text-muted-foreground mt-1 text-sm">
          <PendingText
            barClassName="w-64 max-w-full"
            id={
              kind === "subscription"
                ? "settings.organization.usagePlansDescription"
                : "settings.organization.usagePacksDescription"
            }
          />
        </p>
        <ul className="mt-4 space-y-3">{children}</ul>
      </FramePanel>
    </Frame>
  );
}

export function UsagePlanRowFace({
  details,
  actions,
}: {
  details: ReactNode;
  actions: ReactNode;
}) {
  return (
    <li className="border-border flex flex-wrap items-center justify-between gap-3 rounded-md border p-3">
      <div className="min-w-0 space-y-0.5">{details}</div>
      <div className="flex items-center gap-2">{actions}</div>
    </li>
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
      details={
        <>
          <div className="font-medium">
            <FaceLabelPending className="w-36" />
          </div>
          <p className="text-sm">
            <FaceLabelPending className="w-48" />
          </p>
          <p className="text-sm">
            <FaceLabelPending className="w-24" />
          </p>
        </>
      }
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

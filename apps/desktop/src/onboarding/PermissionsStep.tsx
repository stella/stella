import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { PermissionsSection } from "../mainview/PermissionsSection";
import { PERMISSIONS } from "../shared/permissions";
import { DESKTOP_PLATFORM } from "../shared/use-clipboard-shortcut";
import { DESKTOP_TELEMETRY_WINDOWS } from "../telemetry/desktop-telemetry";
import { NEVER_REQUESTED } from "./onboarding-types";
import type { StepProps } from "./step-props";
import { StepFooter } from "./StepFooter";

export const PermissionsStep = ({
  onBack,
  onContinue,
  snapshot,
}: StepProps) => {
  const t = useTranslations("onboarding");
  const rows = PERMISSIONS.filter(
    (permission) => !snapshot.activityPermissions.includes(permission),
  );
  return (
    <>
      <h1 className="text-xl font-semibold">
        {DESKTOP_PLATFORM === "mac"
          ? t("permissionsTitleMac")
          : t("permissionsTitlePc")}
      </h1>
      <p className="text-muted-foreground mt-1 text-sm">
        {t("permissionsBody")}
      </p>
      <div className="bg-card mt-5 overflow-hidden rounded-xl border">
        <PermissionsSection
          only={rows}
          window={DESKTOP_TELEMETRY_WINDOWS.onboarding}
        />
      </div>
      <div className="text-muted-foreground mt-3 flex flex-wrap items-center gap-1.5 text-xs">
        <span>{t("neverRequested")}</span>
        {NEVER_REQUESTED[DESKTOP_PLATFORM].map((claim) => (
          <span
            className="rounded-full border border-dashed px-2 py-0.5"
            key={claim}
          >
            {t(`never.${claim}`)}
          </span>
        ))}
      </div>
      <StepFooter
        onBack={onBack}
        primary={<Button onClick={onContinue}>{t("continue")}</Button>}
        secondary={
          <Button onClick={onContinue} variant="ghost">
            {t("later")}
          </Button>
        }
        snapshot={snapshot}
      />
    </>
  );
};

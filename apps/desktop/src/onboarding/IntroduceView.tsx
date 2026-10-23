import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Clock3Icon } from "@stll/ui/icons";

import { PermissionsSection } from "../mainview/PermissionsSection";
import { DESKTOP_PLATFORM } from "../shared/use-clipboard-shortcut";
import { DESKTOP_TELEMETRY_WINDOWS } from "../telemetry/desktop-telemetry";
import { FeatureRow } from "./FeatureRow";

type IntroduceViewProps = {
  onDismiss: () => void;
  onOpenActivity: () => void;
};

/**
 * Activity became available after setup. This only explains it: recording
 * starts from the activity window's own consent, which stays with the
 * account.
 */
export const IntroduceView = ({
  onDismiss,
  onOpenActivity,
}: IntroduceViewProps) => {
  const t = useTranslations("onboarding");
  return (
    <>
      <h1 className="text-xl font-semibold">{t("introduceActivityTitle")}</h1>
      <p className="text-muted-foreground mt-1 max-w-md text-sm leading-relaxed">
        {t("introduceActivityBody")}
      </p>
      <div className="bg-card mt-5 overflow-hidden rounded-xl border">
        <FeatureRow
          badge={
            DESKTOP_PLATFORM === "mac" ? t("staysLocalMac") : t("staysLocalPc")
          }
          description={t("howActivityBody")}
          icon={<Clock3Icon className="size-4" />}
          title={t("howActivity")}
        />
        <PermissionsSection
          only={["accessibility"]}
          window={DESKTOP_TELEMETRY_WINDOWS.onboarding}
        />
      </div>
      <div className="mt-auto flex justify-end gap-2 pt-5">
        <Button onClick={onDismiss} variant="ghost">
          {t("later")}
        </Button>
        <Button onClick={onOpenActivity}>{t("openActivity")}</Button>
      </div>
    </>
  );
};

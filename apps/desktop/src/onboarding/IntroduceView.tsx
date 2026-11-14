import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import type { Permission } from "../shared/permissions";
import { ActivityExplainer } from "./ActivityExplainer";

type IntroduceViewProps = {
  activityPermissions: readonly Permission[];
  onDismiss: () => void;
  onOpenActivity: () => void;
};

/**
 * Activity became available after setup. This only explains it: recording
 * starts from the activity window's own consent, which stays with the
 * account.
 */
export const IntroduceView = ({
  activityPermissions,
  onDismiss,
  onOpenActivity,
}: IntroduceViewProps) => {
  const t = useTranslations("onboarding");
  return (
    <>
      <h1 className="text-xl font-semibold">{t("introduceActivityTitle")}</h1>
      <p className="text-muted-foreground mt-1 mb-4 max-w-md text-sm leading-relaxed text-pretty">
        {t("introduceActivityBody")}
      </p>
      <ActivityExplainer permissions={activityPermissions} />
      <div className="mt-auto flex justify-end gap-2 pt-5">
        <Button onClick={onDismiss} variant="ghost">
          {t("later")}
        </Button>
        <Button onClick={onOpenActivity}>{t("openActivity")}</Button>
      </div>
    </>
  );
};

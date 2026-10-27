import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import { PermissionsSection } from "../mainview/PermissionsSection";
import type { Permission } from "../shared/permissions";
import { DESKTOP_TELEMETRY_WINDOWS } from "../telemetry/desktop-telemetry";

type FixViewProps = {
  onDismiss: () => void;
  permissions: readonly Permission[];
};

/** A permission granted before was turned off; only its rows show. */
export const FixView = ({ onDismiss, permissions }: FixViewProps) => {
  const t = useTranslations("onboarding");
  return (
    <>
      <h1 className="text-xl font-semibold">{t("fixTitle")}</h1>
      <p className="text-muted-foreground mt-1 max-w-md text-sm leading-relaxed">
        {t("fixBody")}
      </p>
      <div className="bg-card mt-5 overflow-hidden rounded-xl border">
        <PermissionsSection
          only={permissions}
          window={DESKTOP_TELEMETRY_WINDOWS.onboarding}
        />
      </div>
      <div className="mt-auto flex justify-end gap-2 pt-5">
        <Button onClick={onDismiss} variant="ghost">
          {t("notNow")}
        </Button>
        <Button onClick={onDismiss}>{t("done")}</Button>
      </div>
    </>
  );
};

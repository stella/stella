import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { Label } from "@stll/ui/label";

import type {
  ActivityCaptureSettings,
  ActivityDetailsAccess,
} from "./activity-types";

/**
 * The detail-capture opt-in, shown in the welcome and in the settings. Which
 * apps and browsers record titles is chosen per app in the settings list and
 * in the Activity window's browser question, never here.
 */
export const CaptureDetailsControl = ({
  description = "visible",
  onCommand,
  settings,
}: CaptureDetailsControlProps) => {
  const t = useTranslations("activity");
  return (
    <div className="flex flex-col gap-2">
      <Label className="items-start gap-2" htmlFor="activity-capture-details">
        <Checkbox
          checked={settings.captureDetails}
          id="activity-capture-details"
          onCheckedChange={(enabled) =>
            onCommand("activity_set_capture_details", { enabled })
          }
        />
        <span>{t("captureDetails")}</span>
      </Label>
      {description === "visible" ? (
        <p className="text-muted-foreground text-xs">
          {t("captureDetailsDescription")}
        </p>
      ) : null}
      <DetailsAccessNotice
        access={settings.detailsAccess}
        onCommand={onCommand}
      />
    </div>
  );
};

/** The settings commands the detail-capture controls send. */
export type CaptureDetailsCommand =
  "activity_open_accessibility_settings" | "activity_set_capture_details";

type CaptureDetailsControlProps = {
  onCommand: (
    command: CaptureDetailsCommand,
    args?: Record<string, unknown>,
  ) => void;
  settings: ActivityCaptureSettings;
  description?: "visible" | "collapsed";
};

type DetailsAccessNoticeProps = {
  access: ActivityDetailsAccess;
  onCommand: CaptureDetailsControlProps["onCommand"];
};

const DetailsAccessNotice = ({
  access,
  onCommand,
}: DetailsAccessNoticeProps) => {
  const t = useTranslations("activity");
  switch (access) {
    case "disabled":
    case "ready":
      return null;
    case "accessibilityRequired":
      return (
        <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
          <p>{t("accessibilityRequired")}</p>
          <Button
            onClick={() => onCommand("activity_open_accessibility_settings")}
            size="sm"
            variant="ghost"
          >
            {t("openAccessibilitySettings")}
          </Button>
        </div>
      );
    case "unavailable":
      return (
        <p className="text-muted-foreground text-xs">
          {t("detailsUnavailable")}
        </p>
      );
    default:
      access satisfies never;
      return panic("Unhandled activity details access");
  }
};

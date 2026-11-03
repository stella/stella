import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { Label } from "@stll/ui/label";

import type {
  ActivityCaptureSettings,
  ActivityDetailsAccess,
} from "./activity-types";
import { ActivitySourceIcon } from "./ActivitySourceIcon";

/** The detail-capture opt-in, shown in the welcome and in the settings. */
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
      {settings.browserApps.length > 0 ? (
        <div className="flex flex-col gap-2">
          {settings.browserApps.map((browser) => (
            <div className="flex flex-col gap-1" key={browser.identifier}>
              <Label
                className="items-start gap-2"
                htmlFor={`activity-browser-title-${browser.identifier}`}
              >
                <Checkbox
                  id={`activity-browser-title-${browser.identifier}`}
                  checked={settings.browserTitleApps.some(
                    ({ identifier }) => identifier === browser.identifier,
                  )}
                  disabled={
                    !settings.captureDetails ||
                    settings.appNameOnlyApps.some(
                      ({ identifier }) => identifier === browser.identifier,
                    )
                  }
                  onCheckedChange={(enabled) =>
                    onCommand("activity_set_browser_title_capture", {
                      identifier: browser.identifier,
                      name: browser.name,
                      enabled,
                    })
                  }
                />
                <span className="flex items-center gap-1.5">
                  <ActivitySourceIcon
                    appIdentifier={browser.identifier}
                    sourceAppVisuals={settings.sourceAppVisuals}
                  />
                  {t("captureBrowserTitles", { browser: browser.name })}
                </span>
              </Label>
              {settings.appNameOnlyApps.some(
                ({ identifier }) => identifier === browser.identifier,
              ) ? (
                <p className="text-muted-foreground text-xs">
                  {t("browserAppNameOnly")}
                </p>
              ) : null}
            </div>
          ))}
          <p className="text-muted-foreground text-xs">
            {t("browserPrivacyNote")}
          </p>
        </div>
      ) : null}
    </div>
  );
};

/** The settings commands the detail-capture controls send. */
export type CaptureDetailsCommand =
  | "activity_open_accessibility_settings"
  | "activity_set_browser_title_capture"
  | "activity_set_capture_details";

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

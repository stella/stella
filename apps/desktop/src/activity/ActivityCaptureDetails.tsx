import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { CheckIcon, EyeOffIcon } from "@stll/ui/icons";
import { Label } from "@stll/ui/label";

import type {
  ActivityAppExclusion,
  ActivityCaptureSettings,
  ActivityDetailsAccess,
} from "./activity-types";
import type { ExplainedBrowser } from "./title-capture-logic";

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
          <OpenAccessibilitySettingsButton onCommand={onCommand} />
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

type CaptureCommandProps = {
  onCommand: CaptureDetailsControlProps["onCommand"];
};

/** Opens the system list where stella's Accessibility access is granted. */
export const OpenAccessibilitySettingsButton = ({
  onCommand,
  variant = "ghost",
}: CaptureCommandProps & { variant?: "ghost" | "outline" }) => {
  const t = useTranslations("activity");
  return (
    <Button
      onClick={() => onCommand("activity_open_accessibility_settings")}
      size="sm"
      variant={variant}
    >
      {t("openAccessibilitySettings")}
    </Button>
  );
};

/** Under the Activity window's header while Accessibility access is what
 * keeps every window title out. */
export const TitlesAccessStrip = ({ onCommand }: CaptureCommandProps) => {
  const t = useTranslations("activity");
  return (
    <section
      aria-label={t("titlesNotRecorded")}
      className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border px-4 py-3"
      data-activity-titles-access=""
    >
      <div className="flex min-w-0 flex-1 basis-64 gap-3">
        <EyeOffIcon
          aria-hidden="true"
          className="text-muted-foreground mt-0.5 size-4 shrink-0"
        />
        <p className="text-sm text-pretty">
          <strong className="font-semibold">{t("titlesNotRecorded")}</strong>{" "}
          <span className="text-muted-foreground">
            {t("accessibilityAccessMissing")}
          </span>
        </p>
      </div>
      <OpenAccessibilitySettingsButton
        onCommand={onCommand}
        variant="outline"
      />
    </section>
  );
};

type BrowserTitlesNoticeProps = {
  browsers: readonly ExplainedBrowser[];
  onRecord: (browser: ActivityAppExclusion) => void;
};

/** Each browser whose own opt-in withholds its titles, with the action that
 * records them from now on. The action confirms in place and keeps focus:
 * natively disabling the focused button would blur it, and a hover holding
 * it closes when focus leaves. */
export const BrowserTitlesNotice = ({
  browsers,
  onRecord,
}: BrowserTitlesNoticeProps) => {
  const t = useTranslations("activity");
  return (
    <div className="flex flex-col gap-2" data-activity-browser-titles="">
      {browsers.map(({ browser, status }) => (
        <div
          className="flex flex-col items-start gap-1.5"
          key={browser.identifier}
        >
          <p>
            {status === "turnedOn"
              ? t("browserTitlesRecordedFromNow", { browser: browser.name })
              : t("browserTitlesWithheld", { browser: browser.name })}
          </p>
          {status === "turnedOn" ? (
            <Button data-accessible-disabled="" size="xs" variant="outline">
              <CheckIcon aria-hidden="true" />
              {t("recording")}
            </Button>
          ) : (
            <Button
              onClick={() => onRecord(browser)}
              size="xs"
              variant="outline"
            >
              {t("recordTitlesFromNow")}
            </Button>
          )}
        </div>
      ))}
      <p className="text-muted-foreground">{t("earlierTimeStaysUntitled")}</p>
    </div>
  );
};

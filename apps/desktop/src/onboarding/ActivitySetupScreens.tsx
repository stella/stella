import { useState } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import type { BillingDraftSettingsControl } from "../activity/billing-draft-settings";
import { PermissionsSection } from "../mainview/PermissionsSection";
import type { Permission } from "../shared/permissions";
import { DESKTOP_TELEMETRY_WINDOWS } from "../telemetry/desktop-telemetry";
import type { ActivitySetupScreen } from "./activity-setup-steps";
import { ActivityExplainer } from "./ActivityExplainer";
import {
  Facts,
  ScreenContent,
  ScreenHeader,
  SwitchCard,
} from "./SetupScreenParts";
import type {
  ActivitySetupControls,
  ActivitySetupSnapshot,
} from "./use-activity-setup";

type ScreenProps = {
  controls: ActivitySetupControls;
  snapshot: ActivitySetupSnapshot;
};

type ActivitySetupScreenBodyProps = ScreenProps & {
  drafts: BillingDraftSettingsControl;
  /** The permissions the details screen asks for. */
  permissions: readonly Permission[];
  /** The line under the first screen's title. */
  recordingBody: string;
  screen: ActivitySetupScreen;
};

/** One screen of the Activity step: its title, one plain line under it,
 *  and its choice, in the words Settings → Activity uses. */
export const ActivitySetupScreenBody = ({
  controls,
  drafts,
  permissions,
  recordingBody,
  screen,
  snapshot,
}: ActivitySetupScreenBodyProps) => {
  switch (screen) {
    case "recording":
      return <RecordingScreen body={recordingBody} />;
    case "details":
      return (
        <DetailsScreen
          controls={controls}
          permissions={permissions}
          snapshot={snapshot}
        />
      );
    case "calls":
      return <CallsScreen controls={controls} snapshot={snapshot} />;
    case "aiDrafts":
      return <AiDraftsScreen drafts={drafts} />;
    default:
      screen satisfies never;
      return panic("Unknown activity setup screen.");
  }
};

/** 1. What Activity records, keeps and sends; its Continue starts it. */
const RecordingScreen = ({ body }: { body: string }) => {
  const t = useTranslations("onboarding");
  return (
    <>
      <ScreenHeader body={body} title={t("activityTitle")} />
      <ScreenContent>
        <ActivityExplainer />
      </ScreenContent>
    </>
  );
};

/** 2. Window titles and documents, with the Accessibility access a Mac
 *  needs to read them. */
const DetailsScreen = ({
  controls,
  permissions,
  snapshot,
}: ScreenProps & { permissions: readonly Permission[] }) => {
  const t = useTranslations("onboarding.activitySetup.details");
  const activityT = useTranslations("activity");
  return (
    <>
      <ScreenHeader body={t("body")} title={t("title")} />
      <ScreenContent>
        <SwitchCard
          checked={snapshot.captureDetails}
          description={activityT("captureDetailsDescription")}
          onChange={(enabled) => {
            void controls.setCaptureDetails(enabled);
          }}
          title={activityT("captureDetails")}
        />
        {permissions.length === 0 ? null : (
          <div className="bg-card overflow-hidden rounded-xl border">
            <PermissionsSection
              only={permissions}
              window={DESKTOP_TELEMETRY_WINDOWS.onboarding}
            />
          </div>
        )}
        <Facts
          facts={
            snapshot.captureDetails ? [t("browsers")] : [t("appNamesOnly")]
          }
        />
      </ScreenContent>
    </>
  );
};

/** 3. Time on calls. */
const CallsScreen = ({ controls, snapshot }: ScreenProps) => {
  const t = useTranslations("onboarding.activitySetup.calls");
  const activityT = useTranslations("activity");
  return (
    <>
      <ScreenHeader body={t("body")} title={t("title")} />
      <ScreenContent>
        <SwitchCard
          checked={snapshot.detectCalls}
          description={activityT("detectCallsDescription")}
          onChange={(enabled) => {
            void controls.setDetectCalls(enabled);
          }}
          title={activityT("detectCalls")}
        />
      </ScreenContent>
    </>
  );
};

/** What the drafts switch is doing: idle, saving the choice it shows, or
 *  back after a save the server did not confirm. */
type ConsentSave =
  { type: "idle" } | { enabled: boolean; type: "saving" } | { type: "failed" };

/** 4. Consent to stella AI drafts, in the words the time entry card asks
 *  with; it is the same consent, kept with the account. */
const AiDraftsScreen = ({
  drafts,
}: {
  drafts: BillingDraftSettingsControl;
}) => {
  const t = useTranslations("onboarding.activitySetup.aiDrafts");
  const onboardingT = useTranslations("onboarding");
  const activityT = useTranslations("activity");
  const [save, setSave] = useState<ConsentSave>({ type: "idle" });
  const { settings } = drafts;
  // Only a confirmed grant shows as on: a grant the server never confirmed
  // stays unconfirmed in the consent owner, and the switch must stay usable
  // to try again or to withdraw.
  const granted = settings.type === "ready" && settings.consent === "granted";
  const choose = async (enabled: boolean) => {
    setSave({ enabled, type: "saving" });
    const saved = await drafts.setConsent(enabled ? "granted" : "revoked");
    setSave(saved ? { type: "idle" } : { type: "failed" });
  };
  return (
    <>
      <ScreenHeader body={t("body")} title={activityT("billingDraftsTitle")} />
      <ScreenContent>
        <SwitchCard
          checked={save.type === "saving" ? save.enabled : granted}
          description={activityT("aiDraftConsent")}
          disabled={save.type === "saving"}
          onChange={(enabled) => {
            void choose(enabled);
          }}
          title={t("allow")}
        />
        {save.type === "failed" ? (
          <p className="text-destructive-foreground px-1 text-sm" role="alert">
            {activityT("errorUpdate")}
          </p>
        ) : null}
        {/* A withdrawal stella has not confirmed is off here already; it is
            sent again from here, not only when the window next reads. */}
        {save.type !== "saving" &&
        settings.type === "ready" &&
        settings.consent === "pending-withdrawal" ? (
          <div className="flex items-center justify-between gap-4 px-1">
            <p className="text-muted-foreground min-w-0 text-sm" role="status">
              {activityT("billingDraftsWithdrawPending")}
            </p>
            <Button
              className="shrink-0"
              onClick={() => {
                void choose(false);
              }}
              variant="outline"
            >
              {onboardingT("tryAgain")}
            </Button>
          </div>
        ) : null}
        <Facts facts={[t("withdraw")]} />
      </ScreenContent>
    </>
  );
};

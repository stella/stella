import { panic } from "better-result";
import { useTranslations } from "use-intl";

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

/** 4. Consent to stella AI drafts, in the words the time entry card asks
 *  with; it is the same consent, kept with the account. */
const AiDraftsScreen = ({
  drafts,
}: {
  drafts: BillingDraftSettingsControl;
}) => {
  const t = useTranslations("onboarding.activitySetup.aiDrafts");
  const activityT = useTranslations("activity");
  const { settings } = drafts;
  const consent = settings.type === "ready" ? settings.consent : "unavailable";
  return (
    <>
      <ScreenHeader body={t("body")} title={activityT("billingDraftsTitle")} />
      <ScreenContent>
        <SwitchCard
          checked={consent === "granted" || consent === "pending-grant"}
          description={activityT("aiDraftConsent")}
          disabled={consent === "pending-grant"}
          onChange={(enabled) => {
            void drafts.setConsent(enabled ? "granted" : "revoked");
          }}
          title={t("allow")}
        />
        <Facts facts={[t("withdraw")]} />
      </ScreenContent>
    </>
  );
};

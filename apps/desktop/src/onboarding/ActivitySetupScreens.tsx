import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";

import type { ActivityRecordedFact } from "../activity/activity-disclosure";
import { useStoredFact } from "../activity/ActivityDisclosure";
import type { BillingDraftSettingsControl } from "../activity/billing-draft-settings";
import type { DraftConsentStatus } from "../activity/billing-draft-transport";
import {
  DraftConsentRefused,
  useDraftConsentText,
} from "../activity/DraftConsent";
import { PermissionsSection } from "../mainview/PermissionsSection";
import type { Permission } from "../shared/permissions";
import { DESKTOP_TELEMETRY_WINDOWS } from "../telemetry/desktop-telemetry";
import {
  DETAILS_CHOICE_CAPTURES,
  DETAILS_CHOICES,
  shownDetailsChoice,
} from "./activity-setup-steps";
import type {
  ActivitySetupScreen,
  DetailsAnswer,
  DetailsChoice,
} from "./activity-setup-steps";
import { ActivityExplainer } from "./ActivityExplainer";
import {
  ChoiceCard,
  ChoiceGroup,
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
  /** Whether the details screen was answered during this setup. */
  detailsAnswer: DetailsAnswer;
  drafts: BillingDraftSettingsControl;
  onDetailsAnswer: () => void;
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
  detailsAnswer,
  drafts,
  onDetailsAnswer,
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
          answer={detailsAnswer}
          controls={controls}
          onAnswer={onDetailsAnswer}
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

/** What each details answer records, in the disclosure's own words. */
const DETAILS_CHOICE_FACTS = {
  appNamesOnly: "app",
  withDetails: "details",
} as const satisfies Record<DetailsChoice, ActivityRecordedFact>;

type DetailsScreenProps = ScreenProps & {
  answer: DetailsAnswer;
  onAnswer: () => void;
  permissions: readonly Permission[];
};

/** 2. App names only, or window titles and documents too: neither is
 *  chosen until the user picks one. With details, the Accessibility access
 *  a Mac needs to read them. */
const DetailsScreen = ({
  answer,
  controls,
  onAnswer,
  permissions,
  snapshot,
}: DetailsScreenProps) => {
  const t = useTranslations("onboarding.activitySetup.details");
  const activityT = useTranslations("activity");
  const disclosureT = useTranslations("activity.disclosure");
  const stored = useStoredFact();
  const shown = shownDetailsChoice(answer, snapshot.captureDetails);
  const choose = async (choice: DetailsChoice) => {
    if (await controls.setCaptureDetails(DETAILS_CHOICE_CAPTURES[choice])) {
      onAnswer();
    }
  };
  return (
    <>
      <ScreenHeader body={t("body")} title={t("title")} />
      <ScreenContent>
        <ChoiceGroup label={t("title")}>
          {DETAILS_CHOICES.map((choice) => (
            <ChoiceCard
              checked={shown === choice}
              description={disclosureT(
                `recorded.${DETAILS_CHOICE_FACTS[choice]}`,
              )}
              key={choice}
              onChoose={() => {
                void choose(choice);
              }}
              title={t(`choices.${choice}`)}
              value={choice}
            />
          ))}
        </ChoiceGroup>
        {permissions.length === 0 ? null : (
          <div className="bg-card overflow-hidden rounded-xl border">
            <PermissionsSection
              only={permissions}
              window={DESKTOP_TELEMETRY_WINDOWS.onboarding}
            />
          </div>
        )}
        <Facts
          facts={[
            stored,
            disclosureT("detailsStay"),
            ...(shown === "withDetails"
              ? [
                  snapshot.browserTitlesManaged
                    ? activityT("browserTitlesManaged")
                    : t("browsers"),
                ]
              : []),
          ]}
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
 *  with; it is the same consent, kept with the account, and its one owner
 *  says whether a grant or a withdrawal is on its way or went unconfirmed. */
const AiDraftsScreen = ({
  drafts,
}: {
  drafts: BillingDraftSettingsControl;
}) => {
  const t = useTranslations("onboarding.activitySetup.aiDrafts");
  const activityT = useTranslations("activity");
  const { setConsent, settings } = drafts;
  const consentText = useDraftConsentText();
  const consent = settings.type === "ready" ? settings.consent : "unavailable";
  const choose = (enabled: boolean) => {
    void setConsent(enabled ? "granted" : "revoked");
  };
  return (
    <>
      <ScreenHeader body={t("body")} title={activityT("billingDraftsTitle")} />
      <ScreenContent>
        <SwitchCard
          checked={consentSwitch(consent) === "on"}
          description={consentText}
          disabled={
            consent === "pending-grant" || consent === "pending-withdrawal"
          }
          onChange={choose}
          title={t("allow")}
        />
        {consent === "grant-refused" ? (
          <div className="px-1 text-sm">
            <DraftConsentRefused />
          </div>
        ) : null}
        {/* A withdrawal stella has not confirmed is off here already; it is
            sent again from here, not only when the window next reads. */}
        {consent === "withdrawal-unconfirmed" ? (
          <div className="flex items-center justify-between gap-4 px-1">
            <p className="text-muted-foreground min-w-0 text-sm" role="status">
              {activityT("billingDraftsWithdrawPending")}
            </p>
            <Button
              className="shrink-0"
              onClick={() => {
                choose(false);
              }}
              variant="outline"
            >
              {activityT("retry")}
            </Button>
          </div>
        ) : null}
        <Facts facts={[t("withdraw")]} />
      </ScreenContent>
    </>
  );
};

/** The drafts switch shows the choice in force: a grant on its way as on,
 *  a withdrawal on its way or unconfirmed as off, since it applies at once. */
const consentSwitch = (consent: DraftConsentStatus) => {
  switch (consent) {
    case "granted":
    case "pending-grant":
      return "on";
    case "unavailable":
    case "revoked":
    case "grant-refused":
    case "pending-withdrawal":
    case "withdrawal-unconfirmed":
      return "off";
    default:
      consent satisfies never;
      return panic("Unknown stella AI draft consent.");
  }
};

import { startTransition, useEffect, useRef, useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { panic, Result } from "better-result";
import { useFormatter, useLocale, useTranslations } from "use-intl";

import { displayLanguageName } from "@stll/locales";
import { Temporal } from "@stll/time";
import { Avatar, AvatarFallback } from "@stll/ui/avatar";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stll/ui/combobox";
import { BanIcon } from "@stll/ui/icons";
import { ListItemStatus } from "@stll/ui/list";
import { ScrollArea } from "@stll/ui/scroll-area";
import {
  SettingsPanel,
  SettingsRow,
  settingsRowIds,
  SettingsSection,
} from "@stll/ui/settings";
import { StellaMark } from "@stll/ui/stella-mark";
import { Switch } from "@stll/ui/switch";
import { cn } from "@stll/ui/utils";

import { ACTIVITY_CHANGED_EVENT } from "../activity/activity-types";
import {
  ActivitySettingsPane,
  ActivitySettingsSkeleton,
} from "../activity/ActivitySettings";
import {
  isSupportedLanguage,
  setPreferredLanguage,
  SUPPORTED_LANGUAGES,
} from "../i18n";
import type { SupportedLanguage } from "../i18n";
import { NEVER_REQUESTED } from "../onboarding/onboarding-types";
import { accountExpiryDelay } from "../shared/account-expiry";
import { subscribeDesktopEvent } from "../shared/desktop-events";
import { PERMISSIONS } from "../shared/permissions";
import { isAppSnapshot } from "../shared/rpc";
import type {
  AppSnapshot,
  DesktopNotificationPreferences,
  DesktopUpdateSnapshot,
  DocumentRecoverySnapshot,
  RecoveryTarget,
} from "../shared/rpc";
import { DESKTOP_PLATFORM } from "../shared/use-clipboard-shortcut";
import { WindowDragRegion } from "../shared/WindowDragRegion";
import {
  DESKTOP_TELEMETRY_ERROR_CODES,
  DESKTOP_TELEMETRY_OPERATIONS,
  DESKTOP_TELEMETRY_WINDOWS,
  reportDesktopError,
} from "../telemetry/desktop-telemetry";
import { accountDisplay, accountStatusTone } from "./account-presentation";
import type { DesktopAccountState } from "./account-presentation";
import { AgentSubscriptionsSection } from "./AgentSubscriptionsSection";
import type { AgentSettingsFocus } from "./AgentSubscriptionsSection";
import { commandErrorMessage } from "./command-error";
import { DictationSetting, useDictationAvailability } from "./DictationSetting";
import { KeepAwakeSection } from "./KeepAwakeSection";
import { LocalLinkedFoldersSection } from "./LocalLinkedFoldersSection";
import { LocalSkillFoldersSection } from "./LocalSkillFoldersSection";
import { PermissionsSection } from "./PermissionsSection";
import { SettingsPageHeader } from "./settings-layout";
import {
  isAgentSettingsFocus,
  isSettingsPage,
  SETTINGS_PAGES,
} from "./settings-pages";
import type { SettingsPage } from "./settings-pages";
import { SettingsSidebar } from "./SettingsSidebar";
import { ShortcutSetting } from "./ShortcutSetting";
import { SigningDriverSection } from "./SigningDriverSection";
import { AppVersionRow } from "./UpdateCheck";

const DEFAULT_NOTIFICATION_PREFERENCES = {
  documentReady: true,
  revisionCreated: true,
  syncIssues: true,
} satisfies DesktopNotificationPreferences;
const DEFAULT_UPDATE_SNAPSHOT = {
  baseUrl: null,
  channel: null,
  currentHash: null,
  currentVersion: null,
  lastCheckedAt: null,
  latestHash: null,
  latestVersion: null,
  status: "disabled",
  statusMessage: "Update checks are not configured yet.",
  updateAvailable: false,
  updateReady: false,
} satisfies DesktopUpdateSnapshot;

type NotificationPreferenceKey = keyof DesktopNotificationPreferences;

const NOTIFICATION_PREFERENCE_KEYS = [
  "documentReady",
  "syncIssues",
  "revisionCreated",
] as const satisfies readonly NotificationPreferenceKey[];

type MissingNotificationPreferenceKey = Exclude<
  NotificationPreferenceKey,
  (typeof NOTIFICATION_PREFERENCE_KEYS)[number]
>;

true satisfies MissingNotificationPreferenceKey extends never ? true : never;

const isMacDesktop = navigator.userAgent.includes("Mac");

const reportSubscriptionFailure = () => {
  reportDesktopError({
    code: DESKTOP_TELEMETRY_ERROR_CODES.eventSubscriptionFailed,
    operation: DESKTOP_TELEMETRY_OPERATIONS.runtime,
    window: DESKTOP_TELEMETRY_WINDOWS.main,
  });
};

const getInitialPage = (): SettingsPage => {
  const page = window.location.hash.replace(/^#/u, "");
  return isSettingsPage(page) ? page : "general";
};

/** The permissions the Permissions page lists; open at login is an app
 *  setting on General. */
const PERMISSIONS_PAGE_ROWS = PERMISSIONS.filter(
  (permission) => permission !== "openAtLogin",
);

const DocumentRecovery = ({
  recovery,
  onRefresh,
}: {
  recovery: DocumentRecoverySnapshot;
  onRefresh: () => void;
}) => {
  const t = useTranslations("settings");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const act = async (target: RecoveryTarget | "retry") => {
    setBusy(true);
    const result = await Result.tryPromise(async () =>
      target === "retry"
        ? invoke<AppSnapshot>("get_state").then(() => onRefresh())
        : invoke("open_recovery_folder", { target }),
    );
    setError(result.isErr() ? t("recoveryError") : null);
    setBusy(false);
  };
  if (
    !recovery.edits.length &&
    !recovery.unassigned &&
    !recovery.pending &&
    recovery.access === "available"
  ) {
    return null;
  }
  return (
    <SettingsSection title={t("recoveryTitle")}>
      <SettingsPanel inset="flush">
        <div className="space-y-3 px-4 py-3 text-sm">
          {recovery.edits.length ? (
            <>
              <p className="text-muted-foreground">{t("recoveryBody")}</p>
              <ul className="space-y-1">
                {recovery.edits.map((edit) => (
                  <li key={edit.id} className="wrap-break-word">
                    <BidiText>{edit.fileName}</BidiText>
                    {edit.status === "pending"
                      ? ` (${t("recoveryFilePending")})`
                      : ""}
                  </li>
                ))}
              </ul>
              <Button
                disabled={busy}
                onClick={() => {
                  void act("account");
                }}
                variant="outline"
              >
                {t("recoveryOpenFolder")}
              </Button>
            </>
          ) : null}
          {recovery.access === "signInRequired" ? (
            <p className="text-muted-foreground">{t("recoverySignIn")}</p>
          ) : null}
          {recovery.unassigned ? (
            <>
              <p className="text-muted-foreground">{t("recoveryUnassigned")}</p>
              <Button
                disabled={busy}
                onClick={() => {
                  void act("unassigned");
                }}
                variant="outline"
              >
                {t("recoveryOpenUnassigned")}
              </Button>
            </>
          ) : null}
          {recovery.pending ? (
            <>
              <p className="text-muted-foreground">{t("recoveryPending")}</p>
              <Button
                disabled={busy}
                onClick={() => {
                  void act("retry");
                }}
                variant="outline"
              >
                {t("tryAgain")}
              </Button>
            </>
          ) : null}
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </SettingsPanel>
    </SettingsSection>
  );
};

type TelemetryPreferenceState =
  | { status: "loading" }
  | { status: "unavailable" }
  | { status: "ready"; enabled: boolean }
  | { status: "saving"; enabled: boolean };

const TelemetryToggle = () => {
  const [attempt, setAttempt] = useState(0);
  return (
    <TelemetryPreferenceControl
      key={attempt}
      onRetry={() => setAttempt((current) => current + 1)}
    />
  );
};

const TelemetryPreferenceControl = ({ onRetry }: { onRetry: () => void }) => {
  const t = useTranslations("settings");
  const [preference, setPreference] = useState<TelemetryPreferenceState>({
    status: "loading",
  });
  const [error, setError] = useState<"read" | "save" | null>(null);

  useEffect(() => {
    let disposed = false;
    const loadPreference = async () => {
      const result = await Result.tryPromise(async () =>
        invoke<boolean>("get_desktop_telemetry_enabled"),
      );
      if (disposed) {
        return;
      }
      if (Result.isError(result)) {
        setPreference({ status: "unavailable" });
        setError("read");
        return;
      }
      setPreference({ status: "ready", enabled: result.value });
      setError(null);
    };
    void loadPreference();
    return () => {
      disposed = true;
    };
  }, []);

  const savePreference = async (enabled: boolean) => {
    if (preference.status !== "ready") {
      return;
    }
    const previousEnabled = preference.enabled;
    setPreference({ status: "saving", enabled: previousEnabled });
    setError(null);
    const result = await Result.tryPromise(async () =>
      invoke<boolean>("set_desktop_telemetry_enabled", { enabled }),
    );
    if (Result.isError(result)) {
      setPreference({ status: "ready", enabled: previousEnabled });
      setError("save");
      return;
    }
    setPreference({ status: "ready", enabled: result.value });
  };

  const ids = settingsRowIds("desktop-telemetry");
  return (
    <SettingsRow
      description={t("sendCrashReportsDescription")}
      footer={
        error ? (
          <div className="flex items-center justify-between gap-4">
            <p className="text-destructive-foreground text-xs" role="alert">
              {t(
                error === "read" ? "errorReadTelemetry" : "errorSaveTelemetry",
              )}
            </p>
            {error === "read" ? (
              <Button onClick={onRetry} variant="outline">
                {t("tryAgain")}
              </Button>
            ) : null}
          </div>
        ) : null
      }
      id="desktop-telemetry"
      title={t("sendCrashReports")}
    >
      <Switch
        aria-describedby={ids.description}
        aria-labelledby={ids.label}
        checked={
          preference.status === "ready" || preference.status === "saving"
            ? preference.enabled
            : false
        }
        disabled={preference.status !== "ready"}
        id="desktop-telemetry"
        onCheckedChange={(enabled) => {
          void savePreference(enabled);
        }}
      />
    </SettingsRow>
  );
};

const GeneralPane = ({
  language,
  accountState,
  onLanguageChange,
  onAccountAction,
}: {
  language: SupportedLanguage;
  accountState: DesktopAccountState;
  onLanguageChange: (language: SupportedLanguage) => void;
  onAccountAction: () => void;
}) => {
  const t = useTranslations("settings");
  const languageIds = settingsRowIds("desktop-language-row");

  return (
    <>
      <SettingsPageHeader title={t("pages.general")} />
      <SettingsSection title={t("account")}>
        <AccountRow accountState={accountState} onAction={onAccountAction} />
      </SettingsSection>
      <SettingsSection title={t("app")}>
        <SettingsRow id="desktop-language-row" title={t("language")}>
          <Combobox<SupportedLanguage>
            autoHighlight
            items={SUPPORTED_LANGUAGES}
            itemToStringLabel={(supportedLanguage) =>
              displayLanguageName(supportedLanguage)
            }
            onValueChange={(value) => {
              if (value !== null) {
                onLanguageChange(value);
              }
            }}
            value={language}
          >
            <ComboboxInput
              aria-labelledby={languageIds.label}
              className="w-40"
              id="desktop-language"
              showTrigger={false}
            />
            <ComboboxPopup align="end">
              <ComboboxList>
                {(supportedLanguage: SupportedLanguage) => (
                  <ComboboxItem
                    key={supportedLanguage}
                    value={supportedLanguage}
                  >
                    {displayLanguageName(supportedLanguage)}
                  </ComboboxItem>
                )}
              </ComboboxList>
              <ComboboxEmpty>{t("noLanguagesFound")}</ComboboxEmpty>
            </ComboboxPopup>
          </Combobox>
        </SettingsRow>
        {/* Start on login is the app's own permission row, without its
            tile among the other app settings. */}
        <li className="block empty:hidden">
          <PermissionsSection
            media="none"
            only={["openAtLogin"]}
            window={DESKTOP_TELEMETRY_WINDOWS.main}
          />
        </li>
        <SetupGuideSetting />
      </SettingsSection>
      <SettingsSection title={t("privacy")}>
        <TelemetryToggle />
      </SettingsSection>
    </>
  );
};

/** The linked account in one row: who, on which server, how the link is
 *  doing, and the one action that changes it. */
const AccountRow = ({
  accountState,
  onAction,
}: {
  accountState: DesktopAccountState;
  onAction: () => void;
}) => {
  const t = useTranslations("settings");
  const display = accountDisplay(accountState);
  const { presentation } = display;
  const tone = accountStatusTone(presentation.status);
  const host = presentation.host ?? "";
  const description = (() => {
    if (display.email !== null) {
      return (
        <>
          <BidiText>{display.email}</BidiText>
          {presentation.host ? (
            <>
              {" · "}
              <bdi dir="ltr">{presentation.host}</bdi>
            </>
          ) : null}
        </>
      );
    }
    return presentation.descriptionKey
      ? t(presentation.descriptionKey, { host })
      : t("desktopBenefit");
  })();

  return (
    <SettingsRow
      description={description}
      id="desktop-account"
      media={
        <Avatar className="size-8 border">
          <AvatarFallback className="text-xs">
            {display.initials ?? <StellaMark className="size-4" />}
          </AvatarFallback>
        </Avatar>
      }
      title={display.name ?? t("stellaDesktop")}
    >
      {tone === null ? null : (
        <ListItemStatus tone={tone}>{t(presentation.statusKey)}</ListItemStatus>
      )}
      <Button
        disabled={presentation.status === "loading"}
        onClick={onAction}
        variant={presentation.actionVariant}
      >
        {t(presentation.actionKey, { host })}
      </Button>
    </SettingsRow>
  );
};

/** Starts the setup tour again in its own window. */
const SetupGuideSetting = () => {
  const t = useTranslations("settings");
  const [failed, setFailed] = useState(false);
  const restart = async () => {
    const result = await Result.tryPromise(async () =>
      invoke("onboarding_restart"),
    );
    if (Result.isError(result)) {
      reportDesktopError({
        code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
        operation: DESKTOP_TELEMETRY_OPERATIONS.runtime,
        window: DESKTOP_TELEMETRY_WINDOWS.main,
      });
    }
    setFailed(Result.isError(result));
  };
  return (
    <SettingsRow
      description={t("setupGuideDescription")}
      footer={
        failed ? (
          <p className="text-destructive-foreground text-xs" role="alert">
            {t("errorSetupGuide")}
          </p>
        ) : null
      }
      id="setup-guide"
      title={t("setupGuide")}
    >
      <Button
        onClick={() => {
          void restart();
        }}
        variant="outline"
      >
        {t("setupGuideAction")}
      </Button>
    </SettingsRow>
  );
};

/**
 * Sections drawn by their own components, which each render nothing where
 * this account or computer does not offer them. With none shown, one line
 * says so; it waits a moment so a section still reading does not flash it.
 */
const SettingsSections = ({ children }: React.PropsWithChildren) => {
  const t = useTranslations("settings");
  return (
    <>
      <div className="peer flex flex-col gap-6 empty:hidden">{children}</div>
      <p className="text-muted-foreground hidden px-1 text-sm opacity-100 transition-opacity delay-500 duration-200 peer-empty:block starting:opacity-0">
        {t("pageEmpty")}
      </p>
    </>
  );
};

const ClipboardPane = () => {
  const t = useTranslations("settings");
  return (
    <>
      <SettingsPageHeader title={t("pages.clipboard")} />
      <SettingsSection>
        <SettingsPanel inset="flush">
          <ShortcutSetting />
        </SettingsPanel>
      </SettingsSection>
    </>
  );
};

const AgentsPane = ({
  agentSettingsFocus,
  onAgentSettingsShown,
}: {
  agentSettingsFocus: AgentSettingsFocus | null;
  onAgentSettingsShown: () => void;
}) => {
  const t = useTranslations("settings");
  const tSubscriptions = useTranslations("agentSubscriptions");
  const tLocalSkills = useTranslations("localSkills");
  const tLinkedFolders = useTranslations("localLinkedFolders");
  return (
    <>
      <SettingsPageHeader title={t("pages.agents")} />
      <SettingsSections>
        <AgentSubscriptionsSection
          focus={agentSettingsFocus}
          onFocusShown={onAgentSettingsShown}
          renderGroup={(content) => (
            <SettingsSection title={tSubscriptions("title")}>
              <SettingsPanel inset="flush">{content}</SettingsPanel>
            </SettingsSection>
          )}
        />
        <LocalSkillFoldersSection
          renderGroup={(content) => (
            <SettingsSection title={tLocalSkills("title")}>
              <SettingsPanel inset="flush">{content}</SettingsPanel>
            </SettingsSection>
          )}
        />
        <LocalLinkedFoldersSection
          renderGroup={(content) => (
            <SettingsSection title={tLinkedFolders("title")}>
              <SettingsPanel inset="flush">{content}</SettingsPanel>
            </SettingsSection>
          )}
        />
        <KeepAwakeSection />
      </SettingsSections>
    </>
  );
};

const SigningPane = () => {
  const t = useTranslations("settings");
  const tSigningDriver = useTranslations("signingDriver");
  return (
    <>
      <SettingsPageHeader title={t("pages.signing")} />
      <SettingsSections>
        <SigningDriverSection
          renderGroup={(content) => (
            <SettingsSection title={tSigningDriver("title")}>
              <SettingsPanel inset="flush">{content}</SettingsPanel>
            </SettingsSection>
          )}
        />
      </SettingsSections>
    </>
  );
};

const NotificationsPane = ({
  notificationPreferences,
  onPreferenceChange,
  ready,
}: {
  notificationPreferences: DesktopNotificationPreferences;
  onPreferenceChange: (
    key: NotificationPreferenceKey,
    checked: boolean,
  ) => void;
  ready: boolean;
}) => {
  const t = useTranslations("settings");

  const items = NOTIFICATION_PREFERENCE_KEYS.map((key) => {
    const first = key[0] ?? "";
    const labelKey =
      `notification${first.toUpperCase()}${key.slice(1)}` as const;
    const descKey = `${labelKey}Description` as const;
    return { key, label: t(labelKey), description: t(descKey) };
  });

  return (
    <>
      <SettingsPageHeader title={t("pages.notifications")} />
      <SettingsSection>
        {items.map((item) => {
          const ids = settingsRowIds(`notification-${item.key}`);
          return (
            <SettingsRow
              description={item.description}
              disabled={!ready}
              id={`notification-${item.key}`}
              interaction="label"
              key={item.key}
              title={item.label}
            >
              <Checkbox
                aria-describedby={ids.description}
                aria-labelledby={ids.label}
                checked={notificationPreferences[item.key]}
                id={ids.control}
                disabled={!ready}
                onCheckedChange={(checked) => {
                  onPreferenceChange(item.key, checked);
                }}
              />
            </SettingsRow>
          );
        })}
      </SettingsSection>
    </>
  );
};

/** What the app may ask of this computer, and what it never asks for. */
const PermissionsPane = () => {
  const t = useTranslations("settings");
  const tOnboarding = useTranslations("onboarding");
  return (
    <>
      <SettingsPageHeader
        description={t("permissionsDescription")}
        title={t("pages.permissions")}
      />
      <SettingsSection>
        <SettingsPanel inset="flush">
          <PermissionsSection
            only={PERMISSIONS_PAGE_ROWS}
            window={DESKTOP_TELEMETRY_WINDOWS.main}
          />
        </SettingsPanel>
      </SettingsSection>
      <SettingsSection title={t("neverRequested")}>
        <li className="flex flex-wrap gap-x-4 gap-y-1.5 px-4 py-3">
          {NEVER_REQUESTED[DESKTOP_PLATFORM].map((claim) => (
            <span
              className="text-muted-foreground inline-flex items-center gap-1.5 text-xs"
              key={claim}
            >
              <BanIcon aria-hidden="true" className="size-3.5 shrink-0" />
              {tOnboarding(`never.${claim}`)}
            </span>
          ))}
        </li>
      </SettingsSection>
    </>
  );
};

const AboutPane = ({
  accountState,
  onCopyDiagnostics,
  onEmailSupport,
  onRevealSupportRoot,
  update,
}: {
  accountState: DesktopAccountState;
  onCopyDiagnostics: () => void;
  onEmailSupport: () => void;
  onRevealSupportRoot: () => void;
  update: DesktopUpdateSnapshot;
}) => {
  const format = useFormatter();
  const t = useTranslations("settings");

  const versionLabel =
    update.currentVersion ??
    (import.meta.env.DEV ? t("developmentBuild") : t("previewBuild"));
  const linkedAccount =
    accountState.status === "connected" ? accountState.account : null;

  return (
    <>
      <SettingsPageHeader title={t("pages.about")} />
      <SettingsSection>
        <AppVersionRow
          onEmailSupport={onEmailSupport}
          supportEmail={SUPPORT_EMAIL}
          versionLabel={versionLabel}
        />
        {linkedAccount ? (
          <SettingsRow id="about-last-verified" title={t("lastVerified")}>
            <span className="text-muted-foreground text-sm tabular-nums">
              {linkedAccount.verifiedAt
                ? format.dateTime(
                    Temporal.Instant.from(linkedAccount.verifiedAt)
                      .epochMilliseconds,
                    { dateStyle: "medium", timeStyle: "short" },
                  )
                : t("notAvailableYet")}
            </span>
          </SettingsRow>
        ) : null}
      </SettingsSection>

      <SettingsSection title={t("support")}>
        <SettingsRow id="about-support-email" title={SUPPORT_EMAIL}>
          <Button onClick={onEmailSupport} variant="outline">
            {t("email")}
          </Button>
        </SettingsRow>
        <li className="flex items-center gap-2 px-4 py-3">
          <Button
            className="flex-1"
            onClick={onCopyDiagnostics}
            variant="outline"
          >
            {t("copyDiagnostics")}
          </Button>
          <Button
            className="flex-1"
            onClick={onRevealSupportRoot}
            variant="ghost"
          >
            {t("revealAppData")}
          </Button>
        </li>
      </SettingsSection>
    </>
  );
};

/** The address `email_support` writes to (`session_manager::SUPPORT_EMAIL`). */
const SUPPORT_EMAIL = "hello@stll.app";

type ActivityAvailability = "loading" | "enabled" | "disabled";

/**
 * Whether the account has the activity feature, which decides the Activity
 * tab. Reads the feature decision only and again on every activity change,
 * which the native side also emits when the decision changes.
 */
const useActivityAvailability = () => {
  const [availability, setAvailability] =
    useState<ActivityAvailability>("loading");

  useEffect(() => {
    let disposed = false;
    let request = 0;
    const read = () => {
      request += 1;
      const current = request;
      invoke<boolean>("is_activity_enabled")
        .then((enabled) => {
          if (!disposed && current === request) {
            setAvailability(enabled ? "enabled" : "disabled");
          }
          return undefined;
        })
        .catch(() => {
          reportDesktopError({
            code: DESKTOP_TELEMETRY_ERROR_CODES.invokeFailed,
            operation: DESKTOP_TELEMETRY_OPERATIONS.runtime,
            window: DESKTOP_TELEMETRY_WINDOWS.main,
          });
          if (!disposed && current === request) {
            setAvailability("disabled");
          }
        });
    };
    read();
    const stopListening = subscribeDesktopEvent({
      event: ACTIVITY_CHANGED_EVENT,
      handler: read,
      onError: reportSubscriptionFailure,
      onSubscribed: read,
    });
    return () => {
      disposed = true;
      stopListening();
    };
  }, []);

  return availability;
};

const App = () => {
  const t = useTranslations("settings");
  const tActivity = useTranslations("activity");
  const locale = useLocale();
  const [error, setError] = useState<string | null>(null);
  const [state, setState] = useState<AppSnapshot | null>(null);
  // Bumped by every pushed snapshot and every preference edit. The backend
  // pushes `state-changed` after each change, so a command reply applies only
  // while its revision is current: a reply that lost the race to a newer push
  // or edit would revert it.
  const snapshotRevision = useRef(0);
  // Only the newest edit reports a failure: a newer one carries its value too.
  const latestEdit = useRef(0);
  // The backend's latest snapshot, restored when the newest edit fails.
  const confirmedSnapshot = useRef<AppSnapshot | null>(null);
  const [accountState, setAccountState] = useState<DesktopAccountState>({
    status: "loading",
  });
  const accountRefresh = useRef<() => void>(() => undefined);
  const accountGeneration = useRef(0);
  const snapshotGeneration = useRef(0);
  const snapshotRefresh = useRef<() => void>(() => undefined);
  const [activePage, setActivePage] = useState<SettingsPage>(getInitialPage);
  const [agentSettingsFocus, setAgentSettingsFocus] =
    useState<AgentSettingsFocus | null>(null);
  const [dictationFocus, setDictationFocus] = useState<"microphone" | null>(
    null,
  );
  const activityAvailability = useActivityAvailability();
  const dictationAvailability = useDictationAvailability();
  // A requested page that depends on the account stays shown while its
  // availability loads, so opening it does not flash General first; it falls
  // back only once the feature is off.
  const offers = (page: SettingsPage) => {
    switch (page) {
      case "activity":
        return (
          activityAvailability === "enabled" ||
          (activityAvailability === "loading" && activePage === "activity")
        );
      case "dictation":
        return (
          dictationAvailability === "available" ||
          (dictationAvailability === "loading" && activePage === "dictation")
        );
      // The signing driver is a macOS setting; elsewhere the native side
      // refuses it.
      case "signing":
        return DESKTOP_PLATFORM === "mac";
      case "general":
      case "clipboard":
      case "agents":
      case "notifications":
      case "permissions":
      case "about":
        return true;
      default:
        page satisfies never;
        return panic("Unknown settings page");
    }
  };
  const pages = SETTINGS_PAGES.filter(offers);
  const shownPage = pages.includes(activePage) ? activePage : "general";

  useEffect(() => {
    const url = new URL(window.location.href);
    url.hash = activePage;
    window.history.replaceState(
      null,
      "",
      `${url.pathname}${url.search}${url.hash}`,
    );
  }, [activePage]);

  // The native side opens a page (tray, deep links, setup); a link to the
  // coding agents also names where on their page to scroll.
  useEffect(
    () =>
      subscribeDesktopEvent<{ tab: string; focus?: unknown }>({
        event: "activate-tab",
        handler: (event) => {
          const { tab: nextPage, focus } = event.payload;
          if (!isSettingsPage(nextPage)) {
            return;
          }
          setActivePage(nextPage);
          // A focus belongs to the link that sent it; any other opening
          // drops one still waiting for its card.
          setAgentSettingsFocus(
            nextPage === "agents" && isAgentSettingsFocus(focus) ? focus : null,
          );
          setDictationFocus(
            nextPage === "dictation" && focus === "microphone" ? focus : null,
          );
        },
        onError: reportSubscriptionFailure,
      }),
    [],
  );

  // Listen for state changes from Rust backend + initial fetch
  useEffect(() => {
    let disposed = false;

    const stopListening = subscribeDesktopEvent<AppSnapshot>({
      event: "state-changed",
      handler: (event) => {
        // Unsubscribing is itself an IPC round trip, so an event can still
        // arrive after the effect was cleaned up.
        if (disposed) {
          return;
        }

        const detail = event.payload;
        if (!isAppSnapshot(detail)) {
          return;
        }

        snapshotRevision.current += 1;
        confirmedSnapshot.current = detail;
        startTransition(() => {
          setError(null);
          setState(detail);
        });
      },
      onError: reportSubscriptionFailure,
    });

    const syncState = async () => {
      const revision = snapshotRevision.current;
      const request = ++snapshotGeneration.current;
      try {
        const nextState = await invoke<AppSnapshot>("get_state");
        if (
          disposed ||
          revision !== snapshotRevision.current ||
          request !== snapshotGeneration.current
        ) {
          return;
        }

        if (!isAppSnapshot(nextState)) {
          setError(t("errorReadState"));
          return;
        }
        confirmedSnapshot.current = nextState;
        startTransition(() => {
          setError(null);
          setState(nextState);
        });
      } catch (fetchError) {
        if (
          disposed ||
          revision !== snapshotRevision.current ||
          request !== snapshotGeneration.current
        ) {
          return;
        }

        setError(commandErrorMessage(fetchError, t("errorReadState")));
      }
    };

    snapshotRefresh.current = () => {
      void syncState();
    };
    void syncState();

    return () => {
      disposed = true;
      snapshotGeneration.current += 1;
      stopListening();
    };
  }, [t]);

  useEffect(() => {
    let disposed = false;
    const refresh = () => {
      const request = ++accountGeneration.current;
      snapshotGeneration.current += 1;
      snapshotRevision.current += 1;
      latestEdit.current += 1;
      confirmedSnapshot.current = null;
      setState(null);
      snapshotRefresh.current();
      void invoke<
        Exclude<DesktopAccountState, { status: "loading" | "unavailable" }>
      >("account_get_state")
        .then((nextAccountState) => {
          if (!disposed && request === accountGeneration.current) {
            startTransition(() => setAccountState(nextAccountState));
          }
          return;
        })
        .catch(() => {
          if (!disposed && request === accountGeneration.current) {
            startTransition(() => setAccountState({ status: "unavailable" }));
          }
        });
    };
    const stopListening = subscribeDesktopEvent({
      event: "desktop-account-changed",
      handler: refresh,
      onError: reportSubscriptionFailure,
    });
    accountRefresh.current = refresh;
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      accountGeneration.current += 1;
      window.removeEventListener("focus", refresh);
      stopListening();
    };
  }, []);

  const accountExpiresAt =
    accountState.status === "connected" ? accountState.expiresAt : null;
  useEffect(() => {
    if (!accountExpiresAt) {
      return () => undefined;
    }
    const delay = accountExpiryDelay(
      accountExpiresAt,
      Temporal.Now.instant().epochMilliseconds,
    );
    const timer = window.setTimeout(() => accountRefresh.current(), delay);
    return () => window.clearTimeout(timer);
  }, [accountExpiresAt]);

  const notificationPreferences =
    state?.notificationPreferences ?? DEFAULT_NOTIFICATION_PREFERENCES;
  const update = state?.update ?? DEFAULT_UPDATE_SNAPSHOT;

  const handlePreferenceChange = async (
    preferenceKey: NotificationPreferenceKey,
    checked: boolean,
  ) => {
    if (!state) {
      return;
    }

    const nextPreferences = {
      ...state.notificationPreferences,
      [preferenceKey]: checked,
    };
    snapshotRevision.current += 1;
    latestEdit.current += 1;
    const revision = snapshotRevision.current;
    const edit = latestEdit.current;

    startTransition(() => {
      setState((currentState) =>
        currentState
          ? {
              ...currentState,
              notificationPreferences: nextPreferences,
            }
          : currentState,
      );
    });

    try {
      const nextState = await invoke<AppSnapshot>(
        "update_notification_preferences",
        { prefs: nextPreferences },
      );
      if (revision !== snapshotRevision.current) {
        return;
      }

      confirmedSnapshot.current = nextState;
      startTransition(() => {
        setError(null);
        setState(nextState);
      });
    } catch (updateError) {
      if (edit !== latestEdit.current) {
        return;
      }
      const confirmed = confirmedSnapshot.current;
      startTransition(() => {
        setState(confirmed);
        setError(commandErrorMessage(updateError, t("errorUpdatePreferences")));
      });
    }
  };

  const handleCopyDiagnostics = async () => {
    try {
      await invoke<boolean>("copy_diagnostics");
      setError(null);
    } catch (copyError) {
      setError(commandErrorMessage(copyError, t("errorCopyDiagnostics")));
    }
  };

  const handleEmailSupport = async () => {
    try {
      await invoke<boolean>("email_support");
      setError(null);
    } catch (emailError) {
      setError(commandErrorMessage(emailError, t("errorEmailSupport")));
    }
  };

  const handleRevealSupportRoot = async () => {
    try {
      await invoke<boolean>("reveal_support_root");
      setError(null);
    } catch (revealError) {
      setError(commandErrorMessage(revealError, t("errorRevealAppData")));
    }
  };

  const handleLanguageChange = async (language: SupportedLanguage) => {
    try {
      await setPreferredLanguage(language);
      setError(null);
    } catch (languageError) {
      setError(commandErrorMessage(languageError, t("errorUpdateLanguage")));
    }
  };

  const handleOpenStellaWeb = async () => {
    try {
      if (accountState.status === "reconnectRequired") {
        await invoke("account_disconnect");
        setAccountState({
          status: "disconnected",
          server: accountState.server,
        });
      }
      await invoke("open_stella_account");
      setError(null);
    } catch (openError) {
      setError(commandErrorMessage(openError, t("errorOpenStellaWeb")));
    }
  };

  const language = isSupportedLanguage(locale) ? locale : "en";

  const handleAccountAction = () => {
    if (accountState.status === "unavailable") {
      setAccountState({ status: "loading" });
      accountRefresh.current();
      return;
    }
    if (accountState.status === "connected") {
      void invoke("account_disconnect")
        .then(() => {
          setAccountState({
            status: "disconnected",
            server: accountState.server,
          });
          setError(null);
          return;
        })
        .catch((disconnectError: unknown) => {
          setError(
            commandErrorMessage(disconnectError, t("errorDisconnectAccount")),
          );
        });
      return;
    }
    void handleOpenStellaWeb();
  };

  const page = (() => {
    switch (shownPage) {
      case "general":
        return (
          <>
            <GeneralPane
              accountState={accountState}
              language={language}
              onAccountAction={handleAccountAction}
              onLanguageChange={(nextLanguage) => {
                void handleLanguageChange(nextLanguage);
              }}
            />
            {state ? (
              <DocumentRecovery
                recovery={state.documentRecovery}
                onRefresh={() => snapshotRefresh.current()}
              />
            ) : null}
          </>
        );
      case "dictation":
        return (
          <DictationSetting
            focus={dictationFocus}
            onFocusShown={() => {
              setDictationFocus(null);
            }}
          />
        );
      case "clipboard":
        return <ClipboardPane />;
      case "agents":
        return (
          <AgentsPane
            agentSettingsFocus={agentSettingsFocus}
            onAgentSettingsShown={() => {
              setAgentSettingsFocus(null);
            }}
          />
        );
      case "signing":
        return <SigningPane />;
      case "activity":
        return (
          <>
            <SettingsPageHeader title={tActivity("title")} />
            {/* Activity reads nothing until its access is confirmed. */}
            {activityAvailability === "enabled" ? (
              <ActivitySettingsPane />
            ) : (
              <ActivitySettingsSkeleton />
            )}
          </>
        );
      case "notifications":
        return (
          <NotificationsPane
            notificationPreferences={notificationPreferences}
            onPreferenceChange={(preferenceKey, checked) => {
              void handlePreferenceChange(preferenceKey, checked);
            }}
            ready={state !== null}
          />
        );
      case "permissions":
        return <PermissionsPane />;
      case "about":
        return (
          <AboutPane
            accountState={accountState}
            onCopyDiagnostics={() => {
              void handleCopyDiagnostics();
            }}
            onEmailSupport={() => {
              void handleEmailSupport();
            }}
            onRevealSupportRoot={() => {
              void handleRevealSupportRoot();
            }}
            update={update}
          />
        );
      default:
        shownPage satisfies never;
        return panic("Unknown settings page");
    }
  })();

  return (
    <main className="bg-background text-foreground flex h-dvh overflow-hidden">
      <WindowDragRegion />
      <SettingsSidebar
        accountState={accountState}
        current={shownPage}
        onSelect={(nextPage) => {
          setActivePage(nextPage);
          // Choosing a page by hand is never the link's visit.
          setAgentSettingsFocus(null);
        }}
        pages={pages}
        topInset={isMacDesktop ? "titleBar" : "none"}
      />
      {/* The page scrolls inside a frame kept clear of the window's edges
          and of the strip the window is dragged by. */}
      <div
        className={cn(
          "flex min-w-0 flex-1 flex-col pb-4",
          isMacDesktop ? "pt-9" : "pt-4",
        )}
      >
        <ScrollArea className="min-h-0 flex-1" key={shownPage}>
          <div
            className="mx-auto flex max-w-[40rem] flex-col gap-6 px-6 pt-2 pb-4"
            data-page={shownPage}
            data-slot="settings-page"
          >
            {error ? (
              <div
                className="border-destructive/20 bg-destructive/10 text-destructive-foreground rounded-lg border px-3 py-2 text-sm"
                role="alert"
              >
                {error}
              </div>
            ) : null}
            {page}
          </div>
        </ScrollArea>
      </div>
    </main>
  );
};

export default App;

import { useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import type { SettingsCheck } from "@stll/api-contract/desktop-rpc";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { SettingsRow } from "@stll/ui/settings";

import { StellaAppIcon } from "../shared/StellaAppIcon";

/**
 * The About page's version row. "Check for updates" asks the native updater
 * whether a newer version exists without installing it; an update it finds is
 * installed only when the user asks, through the same check the tray runs.
 */
export const AppVersionRow = ({
  onEmailSupport,
  supportEmail,
  versionLabel,
}: {
  onEmailSupport: () => void;
  supportEmail: string;
  versionLabel: string;
}) => {
  const t = useTranslations("settings");
  const tTray = useTranslations("tray");
  const [check, setCheck] = useState<CheckState>({ status: "idle" });

  const runCheck = async () => {
    setCheck({ status: "checking" });
    const result = await Result.tryPromise(async () =>
      invoke<unknown>("check_for_updates"),
    );
    setCheck(nativeCheckState(result, "check"));
  };

  const install = async (version: string) => {
    // On success the app quits to relaunch, so this may never resolve.
    setCheck({ status: "installing", version });
    const result = await Result.tryPromise(async () =>
      invoke<unknown>("install_update"),
    );
    setCheck(nativeCheckState(result, "install"));
  };

  // A check in flight shows as loading, which already blocks a second one.
  const installing = check.status === "installing";
  return (
    <SettingsRow
      description={versionLabel}
      footer={
        check.status === "idle" || check.status === "checking" ? null : (
          <div aria-live="polite" className="flex flex-col gap-1 text-sm">
            <CheckOutcome
              check={check}
              onInstall={(version) => {
                void install(version);
              }}
            />
            <p className="text-muted-foreground">
              {t.rich("updates.support", {
                address: supportEmail,
                email: (chunks) => (
                  <Button onClick={onEmailSupport} size="inline" variant="link">
                    <BidiText as="span">{chunks}</BidiText>
                  </Button>
                ),
              })}
            </p>
          </div>
        )
      }
      id="about-app"
      media={<StellaAppIcon className="size-8 rounded-lg" />}
      title={t("stellaDesktop")}
    >
      <Button
        disabled={installing}
        disabledReason={installing ? t("updates.installInProgress") : undefined}
        loading={check.status === "checking"}
        onClick={() => {
          void runCheck();
        }}
        variant="outline"
      >
        {tTray("checkForUpdates")}
      </Button>
    </SettingsRow>
  );
};

const CheckOutcome = ({
  check,
  onInstall,
}: {
  check: Exclude<CheckState, { status: "idle" } | { status: "checking" }>;
  onInstall: (version: string) => void;
}) => {
  const t = useTranslations("settings.updates");
  const tTray = useTranslations("tray");
  switch (check.status) {
    case "up_to_date":
      return <p>{t("upToDate")}</p>;
    case "available":
      return (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <p>{t("available", { version: check.version })}</p>
          <Button
            onClick={() => {
              onInstall(check.version);
            }}
            size="sm"
          >
            {t("install")}
          </Button>
        </div>
      );
    case "installing":
      return <p>{t("installing", { version: check.version })}</p>;
    case "deferred":
      return <p>{t("deferred", { version: check.version })}</p>;
    case "managed":
      return <p>{tTray("updatesManaged")}</p>;
    case "failed":
      return (
        <p className="text-destructive-foreground" role="alert">
          {check.during === "check" ? t("checkFailed") : t("installFailed")}
        </p>
      );
    default:
      check satisfies never;
      return panic("Unknown update check outcome");
  }
};

type CheckState =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "failed"; during: "check" | "install" }
  | SettingsCheck;

type SettingsCheckStatus = SettingsCheck["status"];

// Which statuses carry the version they are about, read off the generated
// contract: a status added, removed or reshaped natively fails to compile
// here instead of reaching Settings as a generic failure.
type CheckPayload<Status extends SettingsCheckStatus> =
  Extract<SettingsCheck, { status: Status }> extends { version: string }
    ? "version"
    : "none";

const CHECK_PAYLOADS = {
  up_to_date: "none",
  available: "version",
  deferred: "version",
  installing: "version",
  managed: "none",
} as const satisfies { [Status in SettingsCheckStatus]: CheckPayload<Status> };

const isCheckStatus = (status: unknown): status is SettingsCheckStatus =>
  typeof status === "string" && Object.hasOwn(CHECK_PAYLOADS, status);

/** What `check_for_updates` and `install_update` answer; a failure is the
 *  command's error. */
const isSettingsCheck = (value: unknown): value is SettingsCheck => {
  if (
    typeof value !== "object" ||
    value === null ||
    !("status" in value) ||
    !isCheckStatus(value.status)
  ) {
    return false;
  }
  return (
    CHECK_PAYLOADS[value.status] === "none" ||
    ("version" in value && typeof value.version === "string")
  );
};

const nativeCheckState = (
  result: Result<unknown, unknown>,
  during: "check" | "install",
): CheckState =>
  Result.isOk(result) && isSettingsCheck(result.value)
    ? result.value
    : { status: "failed", during };

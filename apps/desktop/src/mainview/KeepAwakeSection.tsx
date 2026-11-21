import { useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import {
  SettingsRow,
  settingsRowIds,
  SettingsSection,
} from "@stll/ui/settings";
import { Switch } from "@stll/ui/switch";

import { useNativeStatus } from "./AgentSubscriptionsSection";

/**
 * Whether this computer stays awake while agents work on it. It renders
 * nothing unless the local agents feature is on: the read command refuses
 * otherwise.
 */
export const KeepAwakeSection = () => {
  const t = useTranslations("keepAwake");
  const [stored, refresh] = useNativeStatus({
    read: readSettings,
    event: RUNNER_STATE_EVENT,
    isStatus: isKeepAwakeSettings,
  });
  // The choice being saved, shown until the native side answers.
  const [pending, setPending] = useState<KeepAwakeSettings | null>(null);
  const [failed, setFailed] = useState(false);

  if (stored === null) {
    return null;
  }
  const settings = pending ?? stored;

  const save = async (next: KeepAwakeSettings) => {
    setPending(next);
    setFailed(false);
    const result = await Result.tryPromise(async () =>
      invoke("keep_awake_set_settings", { settings: next }),
    );
    setFailed(Result.isError(result));
    setPending(null);
    refresh();
  };

  const enabledIds = settingsRowIds("keep-awake");
  const batteryIds = settingsRowIds("keep-awake-on-battery");
  return (
    <SettingsSection title={t("title")}>
      <SettingsRow
        description={t("description")}
        footer={
          failed ? (
            <p className="text-destructive-foreground text-xs" role="alert">
              {t("errorSave")}
            </p>
          ) : null
        }
        id="keep-awake"
        title={t("enabled")}
      >
        <Switch
          aria-describedby={enabledIds.description}
          aria-labelledby={enabledIds.label}
          checked={settings.enabled}
          disabled={pending !== null}
          id="keep-awake"
          onCheckedChange={(enabled) => {
            void save({ ...settings, enabled });
          }}
        />
      </SettingsRow>
      <SettingsRow
        depth="nested"
        description={t("onBatteryDescription")}
        disabled={!settings.enabled}
        id="keep-awake-on-battery"
        title={t("onBattery")}
      >
        <Switch
          aria-describedby={batteryIds.description}
          aria-labelledby={batteryIds.label}
          checked={settings.onBattery}
          disabled={pending !== null || !settings.enabled}
          id="keep-awake-on-battery"
          onCheckedChange={(onBattery) => {
            void save({ ...settings, onBattery });
          }}
        />
      </SettingsRow>
    </SettingsSection>
  );
};

/** Sent whenever the runner starts or stops, as the local agents feature
 *  turns on or off (`desktop_runner::STATE_EVENT`). */
const RUNNER_STATE_EVENT = "desktop-runner-state-changed";

/** The native side's settings (`keep_awake::KeepAwakeSettings`). */
export type KeepAwakeSettings = {
  enabled: boolean;
  onBattery: boolean;
};

const isKeepAwakeSettings = (value: unknown): value is KeepAwakeSettings =>
  typeof value === "object" &&
  value !== null &&
  "enabled" in value &&
  typeof value.enabled === "boolean" &&
  "onBattery" in value &&
  typeof value.onBattery === "boolean";

const readSettings = async () => invoke<unknown>("keep_awake_get_settings");

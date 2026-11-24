import { useState } from "react";

import { invoke } from "@tauri-apps/api/core";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { SettingsRow, settingsRowIds } from "@stll/ui/settings";

import {
  DESKTOP_APPEARANCES,
  isDesktopAppearance,
} from "../shared/desktop-appearance";
import type { DesktopAppearance } from "../shared/desktop-appearance";
import { useDesktopAppearance } from "../shared/use-desktop-appearance";
import { commandErrorMessage } from "./command-error";

/**
 * Light, dark or the system's appearance for every window. The native side
 * saves the choice and tells every open window; this one takes the saved
 * choice from the answer as well, so it never depends on that event.
 */
export const AppearanceSetting = () => {
  const t = useTranslations("settings");
  const { adopt, appearance } = useDesktopAppearance();
  const [error, setError] = useState<string | null>(null);
  const ids = settingsRowIds("desktop-appearance");
  const label = (value: DesktopAppearance) => t(`appearance.choices.${value}`);

  const choose = async (next: DesktopAppearance) => {
    const result = await Result.tryPromise(async () =>
      invoke("set_desktop_appearance", { appearance: next }),
    );
    if (Result.isError(result)) {
      setError(
        commandErrorMessage(result.error.cause, t("errorUpdateAppearance")),
      );
      return;
    }
    if (!isDesktopAppearance(result.value)) {
      setError(t("errorUpdateAppearance"));
      return;
    }
    adopt(result.value);
    setError(null);
  };

  return (
    <SettingsRow
      footer={
        error === null ? null : (
          <p className="text-destructive-foreground text-xs" role="alert">
            {error}
          </p>
        )
      }
      id="desktop-appearance"
      title={t("appearance.title")}
    >
      <Select
        onValueChange={(value) => {
          if (isDesktopAppearance(value) && value !== appearance) {
            void choose(value);
          }
        }}
        value={appearance}
      >
        <SelectTrigger aria-labelledby={ids.label} className="w-40">
          <SelectValue>
            {(value: unknown) =>
              isDesktopAppearance(value) ? label(value) : null
            }
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {DESKTOP_APPEARANCES.map((value) => (
            <SelectItem key={value} value={value}>
              {label(value)}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </SettingsRow>
  );
};

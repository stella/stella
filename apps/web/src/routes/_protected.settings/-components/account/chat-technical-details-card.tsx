import { useId } from "react";

import { useTranslations } from "use-intl";

import { Field, FieldLabel } from "@stll/ui/field";

import { Switch } from "@/components/switch";
import { usePresentationPrefs } from "@/lib/account/presentation-prefs/provider";
import {
  SETTINGS_SWITCH_ROW_CLASS,
  SettingsSwitchCard,
} from "@/routes/_protected.settings/-components/settings-card.pending";

/** The opt-in for each chat step's code and raw result, beside what the
 *  step looked up and found, which every step shows. */
export const ChatTechnicalDetailsCard = () => {
  const t = useTranslations();
  const id = useId();
  const { prefs, setPrefs } = usePresentationPrefs();

  return (
    <SettingsSwitchCard
      description="settings.account.chatTechnicalDetailsDescription"
      title="settings.account.chatTechnicalDetails"
    >
      <Field className="gap-2">
        <div className={SETTINGS_SWITCH_ROW_CLASS}>
          <Switch
            checked={prefs.chatTechnicalDetails}
            id={id}
            onCheckedChange={(next) => {
              setPrefs(() => ({ chatTechnicalDetails: next }));
            }}
          />
          <FieldLabel htmlFor={id}>
            {t("settings.account.chatTechnicalDetailsToggle")}
          </FieldLabel>
        </div>
      </Field>
    </SettingsSwitchCard>
  );
};

import { useTranslations } from "use-intl";

import { SettingsRow, settingsRowIds } from "@stll/ui/settings";

import { Switch } from "@/components/switch";
import { usePresentationPrefs } from "@/lib/account/presentation-prefs/provider";

const ROW_ID = "chat-technical-details";

/** The opt-in for each chat step's code and raw result, beside what the
 *  step looked up and found, which every step shows. */
export const ChatTechnicalDetailsRow = () => {
  const t = useTranslations();
  const ids = settingsRowIds(ROW_ID);
  const { prefs, setPrefs } = usePresentationPrefs();

  return (
    <SettingsRow
      description={t("settings.account.chatTechnicalDetailsDescription")}
      id={ROW_ID}
      interaction="label"
      title={t("settings.account.chatTechnicalDetails")}
    >
      <Switch
        aria-describedby={ids.description}
        aria-labelledby={ids.label}
        id={ids.control}
        checked={prefs.chatTechnicalDetails}
        onCheckedChange={(next) => {
          setPrefs(() => ({ chatTechnicalDetails: next }));
        }}
      />
    </SettingsRow>
  );
};

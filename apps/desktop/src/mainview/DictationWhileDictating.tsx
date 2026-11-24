import { useTranslations } from "use-intl";

import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { SettingsRow, settingsRowIds } from "@stll/ui/settings";
import { Switch } from "@stll/ui/switch";

const WHILE_DICTATING = ["nothing", "lower", "pause"] as const;

export type WhileDictating = (typeof WHILE_DICTATING)[number];

const isWhileDictating = (value: unknown): value is WhileDictating =>
  WHILE_DICTATING.some((choice) => choice === value);

/**
 * What happens to other sound while dictation records, and, once something
 * does, whether only while it plays through speakers.
 */
export const DictationWhileDictatingRows = ({
  choice,
  offered,
  onChoice,
  onSpeakersOnly,
  speakersOnly,
}: {
  choice: WhileDictating;
  offered: readonly WhileDictating[];
  onChoice: (choice: WhileDictating) => void;
  onSpeakersOnly: (enabled: boolean) => void;
  speakersOnly: boolean;
}) => {
  const t = useTranslations("dictation.whileDictating");
  const ids = settingsRowIds("dictation-while-dictating");
  const speakersIds = settingsRowIds("dictation-speakers-only");
  const label = (value: WhileDictating) => t(`choices.${value}`);
  return (
    <>
      <SettingsRow
        description={t("description")}
        id="dictation-while-dictating"
        title={t("title")}
      >
        <Select
          onValueChange={(value) => {
            if (isWhileDictating(value) && value !== choice) {
              onChoice(value);
            }
          }}
          value={choice}
        >
          <SelectTrigger aria-labelledby={ids.label} className="w-44">
            <SelectValue>
              {(value: unknown) =>
                isWhileDictating(value) ? label(value) : null
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {offered.map((value) => (
              <SelectItem key={value} value={value}>
                {label(value)}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </SettingsRow>
      {choice !== "nothing" && (
        <SettingsRow
          depth="nested"
          description={t("speakersOnly.description")}
          id="dictation-speakers-only"
          title={t("speakersOnly.title")}
        >
          <Switch
            aria-describedby={speakersIds.description}
            aria-labelledby={speakersIds.label}
            checked={speakersOnly}
            onCheckedChange={onSpeakersOnly}
          />
        </SettingsRow>
      )}
    </>
  );
};

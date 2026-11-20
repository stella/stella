import { useId } from "react";

import { useTranslations } from "use-intl";

import { Field, FieldLabel } from "@stll/ui/field";
import {
  Frame,
  FrameDescription,
  FrameHeader,
  FramePanel,
  FrameTitle,
} from "@stll/ui/frame";

import { Switch } from "@/components/switch";
import { usePresentationPrefs } from "@/lib/account/presentation-prefs/provider";

/** The opt-in for each chat step's code and raw result, beside what the
 *  step looked up and found, which every step shows. */
export const ChatTechnicalDetailsCard = () => {
  const t = useTranslations();
  const id = useId();
  const { prefs, setPrefs } = usePresentationPrefs();

  return (
    <Frame>
      <FrameHeader>
        <FrameTitle>{t("settings.account.chatTechnicalDetails")}</FrameTitle>
        <FrameDescription>
          {t("settings.account.chatTechnicalDetailsDescription")}
        </FrameDescription>
      </FrameHeader>
      <FramePanel>
        <div className="p-4">
          <Field className="gap-2">
            <div className="flex min-h-11 flex-row items-center gap-2">
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
        </div>
      </FramePanel>
    </Frame>
  );
};

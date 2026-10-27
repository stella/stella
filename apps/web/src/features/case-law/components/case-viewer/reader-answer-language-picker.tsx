import { useTranslations } from "use-intl";

import { displayLanguageName, isUiLocale } from "@stll/locales";
import { Button } from "@stll/ui/button";
import { GlobeIcon } from "@stll/ui/icons";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@stll/ui/menu";

import { LANG_ENDONYMS, supportedLanguages } from "@/i18n/i18n-store";
import { useMessageLocale } from "@/i18n/message-locale";

export const ReaderAnswerLanguagePicker = ({
  documentLanguage,
  value,
  disabled,
  onChange,
}: {
  documentLanguage: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}) => {
  const t = useTranslations();
  const uiLanguage = useMessageLocale();
  if (documentLanguage.split("-").at(0) === uiLanguage.split("-").at(0)) {
    return null;
  }
  const languageName = (language: string) =>
    isUiLocale(language)
      ? LANG_ENDONYMS[language]
      : displayLanguageName(language);
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            aria-label={t("readerAnswers.answerLanguage")}
            disabled={disabled}
            size="sm"
            variant="ghost"
          />
        }
      >
        <GlobeIcon className="size-3.5" />
        {languageName(value === "document" ? documentLanguage : value)}
      </MenuTrigger>
      <MenuPopup>
        <MenuRadioGroup value={value}>
          <MenuRadioItem value="document" onClick={() => onChange("document")}>
            {t("readerAnswers.documentLanguage", {
              language: languageName(documentLanguage),
            })}
          </MenuRadioItem>
          {supportedLanguages.map((language) => (
            <MenuRadioItem
              key={language}
              value={language}
              onClick={() => onChange(language)}
            >
              {LANG_ENDONYMS[language]}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
};

/**
 * Language combobox shared by the translation dialogs. The locale defaults
 * and the typeahead match key live in the sibling `.logic.ts`.
 */

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  DOCUMENT_TRANSLATION_SOURCE_LANGUAGES,
  isDocumentTranslationSourceLanguageCode,
  type DocumentTranslationSourceLanguageCode,
} from "@stll/api-contract/document-translation";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stll/ui/combobox";

import { matchesLanguageQuery } from "@/components/document-language-picker.logic";
import { useLocale } from "@/i18n/formatting-context";
import { compareByLocale } from "@/lib/collation";
import {
  DEEPL_TARGET_LANGUAGES,
  type DeepLTargetLanguageCode,
} from "@/lib/deepl/languages";

type LanguagePickerProps = {
  id: string;
  label: string;
  languages: readonly { code: DeepLTargetLanguageCode }[];
  value: DeepLTargetLanguageCode | null;
  onChange: (code: DeepLTargetLanguageCode) => void;
  disabled?: boolean | undefined;
};

const LanguagePicker = ({
  id,
  label,
  languages,
  value,
  onChange,
  disabled = false,
}: LanguagePickerProps) => {
  const t = useTranslations();
  const locale = useLocale();

  const options: LanguageOption[] = (() => {
    const items = languages.map((lang) => ({
      code: lang.code,
      label: t(`common.languages.${lang.code}`),
    }));
    const compareLabel = compareByLocale(locale);
    return items.sort((a, b) => compareLabel(a.label, b.label));
  })();

  const selected = options.find((option) => option.code === value) ?? null;

  return (
    <div className="flex flex-col gap-2">
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      <Combobox<LanguageOption>
        autoHighlight
        disabled={disabled}
        filter={matchesLanguageQuery}
        isItemEqualToValue={(a, b) => a.code === b.code}
        items={options}
        itemToStringLabel={(item) => item.label}
        onValueChange={(option) => {
          if (option) {
            onChange(option.code);
          }
        }}
        value={selected}
      >
        <ComboboxInput
          id={id}
          placeholder={t("translate.dialog.selectPlaceholder")}
        />
        <ComboboxPopup>
          <ComboboxList>
            {(item: LanguageOption) => (
              <ComboboxItem key={item.code} value={item}>
                {item.label}
              </ComboboxItem>
            )}
          </ComboboxList>
          <ComboboxEmpty>
            {t("translate.dialog.noLanguagesFound")}
          </ComboboxEmpty>
        </ComboboxPopup>
      </Combobox>
    </div>
  );
};

type LanguageOption = {
  code: DeepLTargetLanguageCode;
  label: string;
};

type DocumentLanguagePickerProps = Omit<LanguagePickerProps, "languages">;

export const DocumentLanguagePicker = (props: DocumentLanguagePickerProps) => (
  <LanguagePicker {...props} languages={DEEPL_TARGET_LANGUAGES} />
);

type DocumentSourceLanguagePickerProps = {
  id: string;
  label: string;
  value: DocumentTranslationSourceLanguageCode | null;
  onChange: (code: DocumentTranslationSourceLanguageCode) => void;
  disabled?: boolean | undefined;
};

export const DocumentSourceLanguagePicker = ({
  onChange,
  ...props
}: DocumentSourceLanguagePickerProps) => (
  <LanguagePicker
    {...props}
    languages={DOCUMENT_TRANSLATION_SOURCE_LANGUAGES}
    onChange={(code) =>
      isDocumentTranslationSourceLanguageCode(code)
        ? onChange(code)
        : panic("Source-language picker returned a target-only language")
    }
  />
);

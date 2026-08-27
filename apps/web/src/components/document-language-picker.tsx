/**
 * Language combobox shared by the bilingual dialogs, plus the defaults both
 * use when they open.
 */

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import {
  DOCUMENT_TRANSLATION_SOURCE_LANGUAGES,
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

const isSourceLanguageCode = (
  code: DeepLTargetLanguageCode,
): code is DocumentTranslationSourceLanguageCode =>
  DOCUMENT_TRANSLATION_SOURCE_LANGUAGES.some(
    (language) => language.code === code,
  );

export const DocumentSourceLanguagePicker = ({
  onChange,
  ...props
}: DocumentSourceLanguagePickerProps) => (
  <LanguagePicker
    {...props}
    languages={DOCUMENT_TRANSLATION_SOURCE_LANGUAGES}
    onChange={(code) =>
      isSourceLanguageCode(code)
        ? onChange(code)
        : panic("Source-language picker returned a target-only language")
    }
  />
);

const DEFAULT_TARGET_LANG: DeepLTargetLanguageCode = "EN-GB";
const FALLBACK_SOURCE_LANG: DeepLTargetLanguageCode = "CS";

/** UI locales whose code differs from the document-language code. */
const LOCALE_TO_LANGUAGE = {
  en: "EN-GB",
} as const satisfies Record<string, DeepLTargetLanguageCode>;

const isMappedLocale = (
  locale: string,
): locale is keyof typeof LOCALE_TO_LANGUAGE =>
  Object.hasOwn(LOCALE_TO_LANGUAGE, locale);

const isLanguageCode = (value: string): value is DeepLTargetLanguageCode =>
  DEEPL_TARGET_LANGUAGES.some((lang) => lang.code === value);

export type DefaultLanguagePair = {
  source: DeepLTargetLanguageCode;
  target: DeepLTargetLanguageCode;
};

/**
 * The UI locale is the best guess for the document's language; the target
 * defaults to English unless the source already is.
 */
export const defaultLanguagePair = (locale: string): DefaultLanguagePair => {
  const mapped = isMappedLocale(locale)
    ? LOCALE_TO_LANGUAGE[locale]
    : locale.toUpperCase();
  const source = isLanguageCode(mapped) ? mapped : FALLBACK_SOURCE_LANG;
  const target =
    source === DEFAULT_TARGET_LANG ? FALLBACK_SOURCE_LANG : DEFAULT_TARGET_LANG;
  return { source, target };
};

/** Default a new translation toward the user's UI language when supported. */
export const defaultTargetLanguage = (
  locale: string,
): DeepLTargetLanguageCode => {
  const mapped = isMappedLocale(locale)
    ? LOCALE_TO_LANGUAGE[locale]
    : locale.toUpperCase();
  return isLanguageCode(mapped) ? mapped : DEFAULT_TARGET_LANG;
};

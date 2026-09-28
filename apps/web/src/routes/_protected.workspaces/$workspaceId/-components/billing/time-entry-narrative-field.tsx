import { useState } from "react";

import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { compareByLocale } from "@stll/collation";
import { displayLanguageName, LANGUAGES, toLanguageCode } from "@stll/locales";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stll/ui/combobox";
import { Label } from "@stll/ui/label";
import { Textarea } from "@stll/ui/textarea";
import { stellaToast } from "@stll/ui/toast";

import { AiRewriteControl } from "@/components/ai-rewrite-control";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useLocale } from "@/i18n/formatting-context";
import { useAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { polishTimeEntryNarrative } from "@/lib/workspaces/time-entries-api";
import { SavedTimeNarratives } from "@/routes/_protected.workspaces/$workspaceId/-components/billing/saved-time-narratives";

type LanguagePick = { code: string; label: string };

type TimeEntryNarrativeFieldProps = {
  id: string;
  onChange: (value: string) => void;
  onLanguageChange: (language: string | null) => void;
  narrativeLanguage: string | null;
  rows?: number | undefined;
  value: string;
  workspaceId: string;
};

/** One narrative field for every time-entry form, including its safe AI polish. */
export const TimeEntryNarrativeField = ({
  id,
  onChange,
  onLanguageChange,
  narrativeLanguage,
  rows = 4,
  value,
  workspaceId,
}: TimeEntryNarrativeFieldProps) => {
  const tAi = useTranslations("ai");
  const tBilling = useTranslations("billing");
  const tCommon = useTranslations("common");
  const t = useTranslations();
  const locale = useLocale();
  const analytics = useAnalytics();
  const [isPolishing, setIsPolishing] = useState(false);
  const getLatestValue = useLatestCallback(() => value);
  const compareLanguageLabel = compareByLocale(locale);
  const languageOptions: LanguagePick[] = LANGUAGES.map((language) => ({
    code: language.code,
    label: displayLanguageName(language.code, { displayLocale: locale }),
  })).toSorted((a, b) => compareLanguageLabel(a.label, b.label));
  const selectedLanguage =
    narrativeLanguage === null
      ? null
      : (languageOptions.find(
          (option) => option.code === toLanguageCode(narrativeLanguage),
        ) ?? {
          code: narrativeLanguage,
          label: displayLanguageName(narrativeLanguage, {
            displayLocale: locale,
          }),
        });

  const polishNarrative = async (instruction: string) => {
    const baseline = getLatestValue();
    const narrative = baseline.trim();
    if (narrative.length === 0 || isPolishing) {
      return;
    }

    setIsPolishing(true);
    const requestResult = await Result.tryPromise(
      async () =>
        await polishTimeEntryNarrative({ instruction, narrative, workspaceId }),
    );
    setIsPolishing(false);

    if (Result.isError(requestResult)) {
      analytics.captureError(requestResult.error);
      stellaToast.add({
        type: "error",
        title: tAi("editWithAI"),
        description: userErrorFromThrown(
          requestResult.error,
          tCommon("unexpectedError"),
        ),
      });
      return;
    }

    if (getLatestValue() !== baseline) {
      stellaToast.add({
        type: "info",
        title: tAi("rewriteDraftChanged"),
      });
      return;
    }

    onChange(requestResult.value.narrative);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex min-h-8 items-center justify-between gap-2">
        <Label htmlFor={id}>{tCommon("description")}</Label>
        <div className="flex items-center gap-1">
          <SavedTimeNarratives
            narrative={value}
            narrativeLanguage={narrativeLanguage}
            onSelect={(selectedNarrative, language) => {
              onChange(selectedNarrative);
              onLanguageChange(language);
            }}
          />
          <AiRewriteControl
            disabled={value.trim().length === 0}
            isPending={isPolishing}
            onRewrite={(instruction) => {
              detached(
                polishNarrative(instruction),
                "time-entry-narrative-field.polish-narrative",
              );
            }}
          />
        </div>
      </div>
      <Textarea
        id={id}
        maxLength={10_000}
        onChange={(event) => onChange(event.currentTarget.value)}
        placeholder={tBilling("narrativePlaceholder")}
        required
        rows={rows}
        value={value}
      />
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-language`}>{tCommon("language")}</Label>
        <Combobox<LanguagePick>
          autoHighlight
          isItemEqualToValue={(a, b) => a.code === b.code}
          items={languageOptions}
          itemToStringLabel={(item) => item.label}
          onValueChange={(option) => onLanguageChange(option?.code ?? null)}
          value={selectedLanguage}
        >
          <ComboboxInput
            id={`${id}-language`}
            placeholder={t("translate.dialog.selectPlaceholder")}
            showClear
          />
          <ComboboxPopup>
            <ComboboxList>
              {(item: LanguagePick) => (
                <ComboboxItem key={item.code} value={item}>
                  {item.label}
                  <span className="text-muted-foreground ms-2 uppercase">
                    {item.code}
                  </span>
                </ComboboxItem>
              )}
            </ComboboxList>
            <ComboboxEmpty>
              {t("translate.dialog.noLanguagesFound")}
            </ComboboxEmpty>
          </ComboboxPopup>
        </Combobox>
      </div>
    </div>
  );
};

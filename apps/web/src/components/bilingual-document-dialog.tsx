/**
 * Bilingual-version trigger + dialog.
 *
 * Mounted next to the translate action on the DOCX viewer. Picks a source
 * and a target language, asks the API for a two-column copy of the document
 * (source text left, a copy to translate right) and links to the new document.
 */

import { useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ColumnsIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stll/ui/combobox";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "@stll/ui/dialog";
import { stellaToast } from "@stll/ui/toast";

import { useLocale } from "@/i18n/formatting-context";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { compareByLocale } from "@/lib/collation";
import {
  DEEPL_TARGET_LANGUAGES,
  type DeepLTargetLanguageCode,
} from "@/lib/deepl/languages";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { toSafeId } from "@/lib/safe-id";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";

type BilingualDocumentDialogProps = {
  workspaceId: string;
  entityId: string;
  fieldId: string;
  /** Disable when the underlying field is missing or not a DOCX. */
  disabled?: boolean | undefined;
};

type LanguageOption = {
  code: DeepLTargetLanguageCode;
  label: string;
};

const DEFAULT_TARGET_LANG: DeepLTargetLanguageCode = "EN-GB";
const FALLBACK_SOURCE_LANG: DeepLTargetLanguageCode = "CS";

const isLanguageCode = (value: string): value is DeepLTargetLanguageCode =>
  DEEPL_TARGET_LANGUAGES.some((lang) => lang.code === value);

/** The UI locale is the best guess for the document's language. */
const defaultSourceLang = (locale: string): DeepLTargetLanguageCode => {
  const upper = locale.toUpperCase();
  if (isLanguageCode(upper)) {
    return upper === DEFAULT_TARGET_LANG ? FALLBACK_SOURCE_LANG : upper;
  }
  return FALLBACK_SOURCE_LANG;
};

export const BilingualDocumentDialog = ({
  workspaceId,
  entityId,
  fieldId,
  disabled = false,
}: BilingualDocumentDialogProps) => {
  const t = useTranslations();
  const locale = useLocale();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const [sourceLang, setSourceLang] = useState<DeepLTargetLanguageCode>(() =>
    defaultSourceLang(locale),
  );
  const [targetLang, setTargetLang] =
    useState<DeepLTargetLanguageCode>(DEFAULT_TARGET_LANG);

  const localizedLanguages: LanguageOption[] = (() => {
    const items: LanguageOption[] = DEEPL_TARGET_LANGUAGES.map((lang) => ({
      code: lang.code,
      label: t(`common.languages.${lang.code}`),
    }));
    const compareLabel = compareByLocale(locale);
    return items.sort((a, b) => compareLabel(a.label, b.label));
  })();

  const findOption = (code: DeepLTargetLanguageCode) =>
    localizedLanguages.find((l) => l.code === code) ?? null;

  const createMutation = useMutation({
    mutationFn: async () => {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .bilingual.post({
          entityId: toSafeId<"entity">(entityId),
          fieldId: toSafeId<"field">(fieldId),
          sourceLang,
          targetLang,
          borders: "none",
        });
      return unwrapEden(response);
    },
    onSuccess: async (data) => {
      stellaToast.add({
        title: t("bilingual.success.title"),
        description: t("bilingual.success.description", {
          fileName: data.fileName,
          rowCount: data.rowCount,
        }),
        type: "success",
        timeout: 10_000,
        action: {
          label: t("common.open"),
          onClick: () => {
            detached(
              navigate({
                to: "/workspaces/$workspaceId/$viewId/document",
                params: { workspaceId, viewId: data.entityId },
                search: { entity: data.entityId, field: data.fieldId },
              }),
              "bilingual-document-dialog.navigate",
            );
          },
        },
      });
      await queryClient.invalidateQueries({
        queryKey: entitiesKeys.all(workspaceId),
      });
      setOpen(false);
    },
    onError: (error: unknown) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("bilingual.error.title"),
        description: userErrorFromThrown(error, t("errors.actionFailed")),
        type: "error",
      });
    },
  });

  const isPending = createMutation.isPending;
  const sameLanguage = sourceLang === targetLang;

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        render={
          <Button
            aria-label={t("bilingual.dialog.title")}
            disabled={disabled}
            size="icon-xs"
            tooltip={t("bilingual.dialog.title")}
            variant="ghost"
          >
            <ColumnsIcon className="size-3.5" />
          </Button>
        }
      />
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("bilingual.dialog.title")}</DialogTitle>
          <DialogDescription>
            {t("bilingual.dialog.description")}
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          <div className="flex flex-col gap-4">
            <LanguagePicker
              emptyLabel={t("translate.dialog.noLanguagesFound")}
              id="bilingual-source"
              label={t("bilingual.dialog.sourceLanguage")}
              onChange={setSourceLang}
              options={localizedLanguages}
              placeholder={t("translate.dialog.selectPlaceholder")}
              value={findOption(sourceLang)}
            />
            <LanguagePicker
              emptyLabel={t("translate.dialog.noLanguagesFound")}
              id="bilingual-target"
              label={t("translate.dialog.targetLanguage")}
              onChange={setTargetLang}
              options={localizedLanguages}
              placeholder={t("translate.dialog.selectPlaceholder")}
              value={findOption(targetLang)}
            />
            {sameLanguage && (
              <p className="text-destructive text-sm">
                {t("bilingual.dialog.sameLanguage")}
              </p>
            )}
          </div>
        </DialogPanel>

        <DialogFooter>
          <DialogClose
            render={
              <Button disabled={isPending} variant="ghost">
                {t("common.cancel")}
              </Button>
            }
          />
          <Button
            disabled={sameLanguage || isPending}
            onClick={() => createMutation.mutate()}
          >
            {isPending
              ? t("bilingual.dialog.creating")
              : t("bilingual.dialog.create")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};

type LanguagePickerProps = {
  id: string;
  label: string;
  options: LanguageOption[];
  value: LanguageOption | null;
  onChange: (code: DeepLTargetLanguageCode) => void;
  placeholder: string;
  emptyLabel: string;
};

const LanguagePicker = ({
  id,
  label,
  options,
  value,
  onChange,
  placeholder,
  emptyLabel,
}: LanguagePickerProps) => (
  <div className="flex flex-col gap-2">
    <label className="text-sm font-medium" htmlFor={id}>
      {label}
    </label>
    <Combobox<LanguageOption>
      autoHighlight
      isItemEqualToValue={(a, b) => a.code === b.code}
      items={options}
      itemToStringLabel={(item) => item.label}
      onValueChange={(option) => {
        if (option) {
          onChange(option.code);
        }
      }}
      value={value}
    >
      <ComboboxInput id={id} placeholder={placeholder} />
      <ComboboxPopup>
        <ComboboxList>
          {(item: LanguageOption) => (
            <ComboboxItem key={item.code} value={item}>
              {item.label}
            </ComboboxItem>
          )}
        </ComboboxList>
        <ComboboxEmpty>{emptyLabel}</ComboboxEmpty>
      </ComboboxPopup>
    </Combobox>
  </div>
);

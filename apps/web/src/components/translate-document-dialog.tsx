/**
 * Translate-document trigger + dialog.
 *
 * Mounted on the document viewer toolbar (PDFs) and via
 * PdfViewerControls.extraControls inside the Folio action bar
 * (DOCX). Surfaces a language picker, kicks off the translate
 * mutation, and on success links the user to the new entity.
 */

import { useMemo, useState } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { LanguagesIcon } from "lucide-react";
import { useLocale, useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stll/ui/components/combobox";
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
} from "@stll/ui/components/dialog";
import { stellaToast } from "@stll/ui/components/toast";

import Tooltip from "@/components/tooltip";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import {
  DEEPL_TARGET_LANGUAGES,
  type DeepLTargetLanguageCode,
} from "@/lib/deepl/languages";
import { deepLAvailabilityOptions } from "@/lib/deepl/queries";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { entitiesKeys } from "@/routes/_protected.workspaces/$workspaceId/-queries/entities";

type TranslateDocumentDialogProps = {
  workspaceId: string;
  fieldId: string;
  /** Disable when the underlying field is missing or unsupported. */
  disabled?: boolean | undefined;
};

const DEFAULT_TARGET_LANG: DeepLTargetLanguageCode = "EN-GB";

export const TranslateDocumentDialog = ({
  workspaceId,
  fieldId,
  disabled = false,
}: TranslateDocumentDialogProps) => {
  const t = useTranslations();
  const locale = useLocale();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const activeOrganizationId = useRouteContext({
    from: "/_protected",
    select: (ctx) => ctx.user.activeOrganizationId,
  });

  const { data: availability } = useQuery(
    deepLAvailabilityOptions({ organizationId: activeOrganizationId }),
  );

  const [open, setOpen] = useState(false);
  const [targetLang, setTargetLang] =
    useState<DeepLTargetLanguageCode>(DEFAULT_TARGET_LANG);

  type LanguageOption = {
    code: DeepLTargetLanguageCode;
    label: string;
  };

  const localizedLanguages = useMemo<LanguageOption[]>(() => {
    const items: LanguageOption[] = DEEPL_TARGET_LANGUAGES.map((lang) => ({
      code: lang.code,
      label: t(`common.languages.${lang.code}`),
    }));
    return items.sort((a, b) => a.label.localeCompare(b.label, locale));
  }, [t, locale]);

  const selectedLanguage =
    localizedLanguages.find((l) => l.code === targetLang) ?? null;

  const translateMutation = useMutation({
    mutationFn: async () => {
      const response = await api
        .entities({ workspaceId: toSafeId<"workspace">(workspaceId) })
        .translate.post({
          fieldId: toSafeId<"field">(fieldId),
          targetLang,
          // Send explicitly: Elysia coerces absent optional UnionEnums to the
          // first value (`default`), which would bypass the client's
          // prefer_more default and ruin legal-register output.
          formality: "prefer_more",
          queryKey: entitiesKeys.all(workspaceId),
        });

      if (response.error) {
        throw toAPIError(response.error);
      }

      return response.data;
    },
    onSuccess: async (data) => {
      stellaToast.add({
        title: t("translate.success.title"),
        description: t("translate.success.description", {
          fileName: data.fileName,
        }),
        type: "success",
      });
      await queryClient.invalidateQueries({
        queryKey: entitiesKeys.all(workspaceId),
      });
      setOpen(false);
      void navigate({
        to: "/workspaces/$workspaceId/$viewId/document",
        params: { workspaceId, viewId: data.entityId },
        // `field` is required by the route guard; without it
        // `RouteComponent` bounces back to the workspace.
        search: { entity: data.entityId, field: data.fieldId },
      });
    },
    onError: (error: unknown) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("translate.error.title"),
        description:
          error instanceof Error ? error.message : t("errors.actionFailed"),
        type: "error",
      });
    },
  });

  const isConfigured = availability?.configured === true;
  const isPending = translateMutation.isPending;

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <Tooltip
        content={t("translate.tooltip")}
        render={
          <DialogTrigger
            render={
              <Button
                disabled={disabled}
                size="icon-xs"
                variant="ghost"
                aria-label={t("translate.tooltip")}
              >
                <LanguagesIcon className="size-3.5" />
              </Button>
            }
          />
        }
      />
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("translate.dialog.title")}</DialogTitle>
          <DialogDescription>
            {t("translate.dialog.description")}
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          {isConfigured ? (
            <div className="flex flex-col gap-3">
              <label className="text-sm font-medium" htmlFor="translate-target">
                {t("translate.dialog.targetLanguage")}
              </label>
              <Combobox<LanguageOption>
                autoHighlight
                isItemEqualToValue={(a, b) => a.code === b.code}
                items={localizedLanguages}
                itemToStringLabel={(item) => item.label}
                onValueChange={(option) => {
                  if (option) {
                    setTargetLang(option.code);
                  }
                }}
                value={selectedLanguage}
              >
                <ComboboxInput
                  id="translate-target"
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
          ) : (
            <div className="bg-muted text-muted-foreground rounded-md p-3 text-sm">
              {t("translate.dialog.notConfigured")}
            </div>
          )}
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
            disabled={!isConfigured || isPending}
            onClick={() => translateMutation.mutate()}
          >
            {isPending
              ? t("translate.dialog.translating")
              : t("translate.dialog.translate")}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};

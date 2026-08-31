/**
 * Bilingual-version trigger + dialog.
 *
 * Mounted next to the translate action on the DOCX viewer. Picks a source
 * and a target language, asks the API for a two-column copy of the document
 * (source text left, a copy to translate right) and links to the new document.
 */

import { useState } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { ColumnsIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
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

import { DocumentLanguagePicker } from "@/components/document-language-picker";
import { defaultLanguagePair } from "@/components/document-language-picker.logic";
import { useLocale } from "@/i18n/formatting-context";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import type { DeepLTargetLanguageCode } from "@/lib/deepl/languages";
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
  // The dialogs live on the document route; the view stays, the document changes.
  const viewId = useParams({
    strict: false,
    select: (params) => params.viewId ?? "all",
  });

  const [open, setOpen] = useState(false);
  const [sourceLang, setSourceLang] = useState<DeepLTargetLanguageCode>(
    () => defaultLanguagePair(locale).source,
  );
  const [targetLang, setTargetLang] = useState<DeepLTargetLanguageCode>(
    () => defaultLanguagePair(locale).target,
  );

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
        description: t.rich("bilingual.success.description", {
          bdi: (chunks) => <BidiText>{chunks}</BidiText>,
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
                params: { workspaceId, viewId },
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
            <DocumentLanguagePicker
              id="bilingual-source"
              label={t("bilingual.dialog.sourceLanguage")}
              onChange={setSourceLang}
              value={sourceLang}
            />
            <DocumentLanguagePicker
              id="bilingual-target"
              label={t("translate.dialog.targetLanguage")}
              onChange={setTargetLang}
              value={targetLang}
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

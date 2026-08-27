/**
 * Unified document translation trigger and background run dialog.
 *
 * A run produces the final document server-side. The dialog can be closed
 * while the run is in progress; the mounted toolbar keeps polling and posts a
 * toast with an Open action when the output is ready.
 */

import { useRef, useState } from "react";
import type { ReactElement } from "react";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouteContext } from "@tanstack/react-router";
import { panic } from "better-result";
import { LanguagesIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import {
  documentTranslationSourceForTarget,
  type DocumentTranslationSourceLanguageDetection,
} from "@stll/api-contract/document-translation";
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

import {
  defaultTargetLanguage,
  DocumentLanguagePicker,
  DocumentSourceLanguagePicker,
} from "@/components/document-language-picker";
import {
  documentTranslationPreparationOptions,
  documentTranslationRunOptions,
  isDocumentTranslationRunActive,
  type DocumentTranslationRun,
} from "@/components/document-translation-queries";
import {
  canStartDocumentTranslation,
  commentPolicyStateForSource,
  resolvedDocumentTranslationSource,
  type DocumentTranslationCommentPolicy,
  type DocumentTranslationCommentPolicyState,
  type DocumentTranslationSourceSelection,
} from "@/components/translate-document-dialog.logic";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useLocale } from "@/i18n/formatting-context";
import { useAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import type { DeepLTargetLanguageCode } from "@/lib/deepl/languages";
import { deepLAvailabilityOptions } from "@/lib/deepl/queries";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { toSafeId } from "@/lib/safe-id";
import { Slot } from "@/lib/slot";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";

type TranslationChoice = "bilingual:ai" | "translated:ai" | "translated:deepl";

type SourceStatusKeyOptions = {
  selection: DocumentTranslationSourceSelection;
  detection: DocumentTranslationSourceLanguageDetection | null;
  hasError: boolean;
  isPending: boolean;
};

type SourceStatusKey =
  | "translate.dialog.sourceDetected"
  | "translate.dialog.sourceDetecting"
  | "translate.dialog.sourceDetectionFailed"
  | "translate.dialog.sourceManual"
  | "translate.dialog.sourceNeedsSelection";

const sourceStatusKey = ({
  selection,
  detection,
  hasError,
  isPending,
}: SourceStatusKeyOptions): SourceStatusKey => {
  if (isPending) {
    return "translate.dialog.sourceDetecting";
  }
  if (hasError) {
    return "translate.dialog.sourceDetectionFailed";
  }
  if (selection.type === "manual") {
    return "translate.dialog.sourceManual";
  }
  return detection?.type === "detected"
    ? "translate.dialog.sourceDetected"
    : "translate.dialog.sourceNeedsSelection";
};

type TranslateDocumentDialogProps = {
  workspaceId: string;
  viewId: string;
  entityId: string;
  fieldId: string;
  entityVersionKey: number | string;
  isDocx: boolean;
  trigger?: ReactElement | undefined;
  /** Disable when the underlying field is missing or the user cannot create output. */
  disabled?: boolean | undefined;
};

const DEFAULT_CHOICE: TranslationChoice = "translated:deepl";
export const TranslateDocumentDialog = ({
  workspaceId,
  viewId,
  entityId,
  fieldId,
  entityVersionKey,
  isDocx,
  trigger,
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
  const [choice, setChoice] = useState<TranslationChoice>(DEFAULT_CHOICE);
  const documentKey = `${entityId}:${fieldId}`;
  const [sourceSelectionState, setSourceSelectionState] = useState<{
    documentKey: string;
    selection: DocumentTranslationSourceSelection;
  }>(() => ({ documentKey, selection: { type: "automatic" } }));
  const sourceSelection =
    sourceSelectionState.documentKey === documentKey
      ? sourceSelectionState.selection
      : ({ type: "automatic" } as const);
  const [targetLang, setTargetLang] = useState<DeepLTargetLanguageCode>(() =>
    defaultTargetLanguage(locale),
  );
  const [runId, setRunId] = useState<string | null>(null);
  const [commentPolicyState, setCommentPolicyState] =
    useState<DocumentTranslationCommentPolicyState>({ type: "unchecked" });
  const activeCommentPolicyState = commentPolicyStateForSource({
    state: commentPolicyState,
    entityId,
    fieldId,
  });
  const preparationQuery = useQuery({
    ...documentTranslationPreparationOptions({
      workspaceId,
      entityId,
      fieldId,
      entityVersionKey,
    }),
    enabled: open && isDocx && runId === null,
  });
  const sourceDetection = preparationQuery.data?.sourceLanguage ?? null;
  const sourceLang = resolvedDocumentTranslationSource({
    selection: sourceSelection,
    detection: sourceDetection,
  });
  const commentsFound =
    activeCommentPolicyState.type === "required" ||
    preparationQuery.data?.hasComments === true;
  const commentPolicy =
    activeCommentPolicyState.type === "required"
      ? activeCommentPolicyState.policy
      : null;
  const selectCommentPolicy = (policy: DocumentTranslationCommentPolicy) =>
    setCommentPolicyState({
      type: "required",
      entityId,
      fieldId,
      policy,
    });
  const terminalNotifiedRunRef = useRef<string | null>(null);
  const pollingErrorRunRef = useRef<string | null>(null);
  const preparationErrorRef = useRef<unknown>(null);

  const isDeepL = choice.endsWith(":deepl");
  const targetSourceLanguage = documentTranslationSourceForTarget(targetLang);
  const sameLanguage =
    sourceLang !== null && sourceLang === targetSourceLanguage;
  const canUseDeepL = availability?.configured === true;
  const runQuery = useQuery({
    ...documentTranslationRunOptions({
      workspaceId,
      runId: runId ?? "",
    }),
    enabled: runId !== null,
  });

  const openOutput = useLatestCallback((run: DocumentTranslationRun) => {
    if (!run.outputEntityId || !run.outputFieldId) {
      return;
    }
    detached(
      navigate({
        to: "/workspaces/$workspaceId/$viewId/document",
        params: { workspaceId, viewId },
        search: { entity: run.outputEntityId, field: run.outputFieldId },
      }),
      "translate-document-dialog.navigate",
    );
  });

  useExternalSyncEffect(() => {
    if (
      preparationQuery.error !== null &&
      preparationErrorRef.current !== preparationQuery.error
    ) {
      preparationErrorRef.current = preparationQuery.error;
      analytics.captureError(preparationQuery.error);
    }
    const run = runQuery.data?.run;
    if (
      runQuery.error !== null &&
      runId !== null &&
      pollingErrorRunRef.current !== runId
    ) {
      pollingErrorRunRef.current = runId;
      analytics.captureError(runQuery.error);
      stellaToast.add({
        title: t("translate.error.title"),
        description: userErrorFromThrown(
          runQuery.error,
          t("errors.actionFailed"),
        ),
        type: "error",
      });
      return;
    }
    if (!run || runId === null || terminalNotifiedRunRef.current === runId) {
      return;
    }
    if (run.status === "completed") {
      terminalNotifiedRunRef.current = runId;
      stellaToast.add({
        title: t("translate.success.title"),
        description: t("translate.success.description", {
          fileName:
            run.outputFileName ?? t("translate.dialog.translatedDocument"),
        }),
        type: "success",
        timeout: 10_000,
        ...(run.outputEntityId && run.outputFieldId
          ? {
              action: {
                label: t("common.open"),
                onClick: () => openOutput(run),
              },
            }
          : {}),
      });
      detached(
        queryClient.invalidateQueries({
          queryKey: entitiesKeys.all(workspaceId),
        }),
        "translate-document-dialog.invalidate-entities",
      );
      return;
    }
    if (run.status === "failed" || run.status === "cancelled") {
      terminalNotifiedRunRef.current = runId;
      stellaToast.add({
        title: t("translate.error.title"),
        description: t("translate.dialog.runFailed"),
        type: "error",
      });
    }
  }, [
    analytics,
    openOutput,
    preparationQuery.error,
    runQuery.data,
    runQuery.error,
    runId,
    queryClient,
    t,
    workspaceId,
  ]);

  const translateMutation = useMutation({
    mutationFn: async () => {
      const client = api.workspaces({
        workspaceId: toSafeId<"workspace">(workspaceId),
      })["document-translations"].runs;
      const common = {
        entityId: toSafeId<"entity">(entityId),
        fieldId: toSafeId<"field">(fieldId),
        ...(commentPolicy === null ? {} : { commentPolicy }),
        targetLang,
      };
      const data = await (async () => {
        switch (choice) {
          case "translated:deepl":
            return unwrapEden(
              await client.post({
                ...common,
                output: "translated",
                engine: "deepl",
              }),
            );
          case "translated:ai":
          case "bilingual:ai": {
            if (sourceLang === null) {
              return panic("AI translation started without a source language");
            }
            const entityVersionId =
              preparationQuery.data?.entityVersionId ??
              panic("AI translation started without a prepared version");
            return unwrapEden(
              await client.post({
                ...common,
                output: choice === "translated:ai" ? "translated" : "bilingual",
                engine: "ai",
                sourceLang,
                entityVersionId,
              }),
            );
          }
          default: {
            const exhaustiveChoice: never = choice;
            return exhaustiveChoice;
          }
        }
      })();
      return {
        data,
        sourceEntityId: entityId,
        sourceFieldId: fieldId,
      };
    },
    onSuccess: ({ data, sourceEntityId, sourceFieldId }) => {
      if (data.type === "commentPolicyRequired") {
        setCommentPolicyState({
          type: "required",
          entityId: sourceEntityId,
          fieldId: sourceFieldId,
          policy: null,
        });
        setOpen(true);
        return;
      }
      setRunId(data.runId);
      setOpen(true);
    },
    onError: (error: unknown) => {
      analytics.captureError(error);
      stellaToast.add({
        title: t("translate.error.title"),
        description: userErrorFromThrown(error, t("errors.actionFailed")),
        type: "error",
      });
    },
  });

  const run = runQuery.data?.run;
  const isStarting = translateMutation.isPending;
  const isLoadingRun = runId !== null && runQuery.isPending;
  const isRunning = run ? isDocumentTranslationRunActive(run.status) : false;
  const progress =
    run && run.total > 0 ? Math.min(1, run.completed / run.total) : 0;
  const canStart = canStartDocumentTranslation({
    canUseDeepL,
    isDeepL,
    isLoadingRun,
    isRunning,
    isStarting,
    hasCommentPolicy: commentPolicy !== null,
    hasPreparedAiSource: preparationQuery.data !== undefined,
    hasResolvedAiSource: sourceLang !== null,
    requiresCommentPolicy: commentsFound,
    sameLanguage,
  });

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (nextOpen && run && !isRunning) {
          setRunId(null);
          setCommentPolicyState({ type: "unchecked" });
        }
        setOpen(nextOpen);
      }}
      open={open}
    >
      {trigger ? (
        <Slot
          onClick={(event) => {
            if (event.defaultPrevented || disabled) {
              return;
            }
            setOpen(true);
          }}
        >
          {trigger}
        </Slot>
      ) : (
        <DialogTrigger
          render={
            <Button
              aria-label={t("common.translate")}
              disabled={disabled}
              size="icon-xs"
              tooltip={t("common.translate")}
              variant="ghost"
            >
              <LanguagesIcon className="size-3.5" />
            </Button>
          }
        />
      )}
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("translate.dialog.title")}</DialogTitle>
          <DialogDescription>
            {t("translate.dialog.description")}
          </DialogDescription>
        </DialogHeader>

        <DialogPanel>
          {run && (isRunning || run.status === "completed") ? (
            <div className="flex flex-col gap-3">
              <p className="text-sm font-medium">
                {run.status === "completed"
                  ? t("translate.dialog.completed")
                  : t("translate.dialog.translating")}
              </p>
              <div
                aria-label={t("translate.dialog.progress")}
                aria-valuemax={run.total}
                aria-valuemin={0}
                aria-valuenow={run.completed}
                className="bg-muted h-1.5 w-full overflow-hidden rounded-full"
                role="progressbar"
              >
                <div
                  className="bg-primary h-full w-full origin-left rounded-full transition-transform duration-500 ease-out"
                  style={{ transform: `scaleX(${String(progress)})` }}
                />
              </div>
              <p className="text-muted-foreground text-xs tabular-nums">
                {t("translate.dialog.progressCount", {
                  completed: String(run.completed),
                  total: String(run.total),
                })}
              </p>
              {run.status === "completed" && run.outputEntityId ? (
                <Button onClick={() => openOutput(run)}>
                  {t("common.open")}
                </Button>
              ) : null}
              {run.status !== "completed" ? (
                <p className="text-muted-foreground text-xs">
                  {t("translate.dialog.backgroundHint")}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-4">
              <fieldset className="flex flex-col gap-2">
                <legend className="text-sm font-medium">
                  {t("translate.dialog.outputLabel")}
                </legend>
                <RadioCard
                  checked={choice === "translated:deepl"}
                  disabled={!canUseDeepL}
                  label={t("translate.dialog.translatedDocument")}
                  onChange={() => setChoice("translated:deepl")}
                  description={t("translate.dialog.deeplDescription")}
                  value="translated:deepl"
                />
                <RadioCard
                  checked={choice === "translated:ai"}
                  disabled={!isDocx}
                  label={t("translate.dialog.translatedDocumentAi")}
                  onChange={() => setChoice("translated:ai")}
                  description={t("translate.dialog.aiDescription")}
                  value="translated:ai"
                />
                <RadioCard
                  checked={choice === "bilingual:ai"}
                  disabled={!isDocx}
                  label={t("translate.dialog.bilingualDocument")}
                  onChange={() => setChoice("bilingual:ai")}
                  description={t("translate.dialog.bilingualDescription")}
                  value="bilingual:ai"
                />
              </fieldset>
              {!canUseDeepL ? (
                <p className="text-muted-foreground text-xs">
                  {t("translate.dialog.notConfigured")}
                </p>
              ) : null}
              {!isDocx ? (
                <p className="text-muted-foreground text-xs">
                  {t("translate.dialog.docxOnly")}
                </p>
              ) : null}
              {!isDeepL ? (
                <div className="flex flex-col gap-1.5">
                  <DocumentSourceLanguagePicker
                    disabled={preparationQuery.isPending}
                    id="translate-source"
                    label={t("bilingual.dialog.sourceLanguage")}
                    onChange={(language) =>
                      setSourceSelectionState({
                        documentKey,
                        selection: { type: "manual", language },
                      })
                    }
                    value={sourceLang}
                  />
                  <p className="text-muted-foreground text-xs">
                    {t(
                      sourceStatusKey({
                        selection: sourceSelection,
                        detection: sourceDetection,
                        hasError: preparationQuery.error !== null,
                        isPending: preparationQuery.isPending,
                      }),
                    )}
                  </p>
                </div>
              ) : null}
              <DocumentLanguagePicker
                id="translate-target"
                label={t("translate.dialog.targetLanguage")}
                onChange={setTargetLang}
                value={targetLang}
              />
              {commentsFound ? (
                <fieldset className="flex flex-col gap-2">
                  <legend className="text-sm font-medium">
                    {t("folio.comments.visibility")}
                  </legend>
                  <p className="text-muted-foreground text-xs">
                    {t("translate.dialog.commentsDescription")}
                  </p>
                  <RadioCard
                    checked={commentPolicy === "original"}
                    disabled={false}
                    label={t("translate.dialog.commentsOriginal")}
                    onChange={() => selectCommentPolicy("original")}
                    description={t(
                      "translate.dialog.commentsOriginalDescription",
                    )}
                    name="comment-policy"
                    value="original"
                  />
                  <RadioCard
                    checked={commentPolicy === "original-and-translated"}
                    disabled={false}
                    label={t("translate.dialog.commentsBoth")}
                    onChange={() =>
                      selectCommentPolicy("original-and-translated")
                    }
                    description={t("translate.dialog.commentsBothDescription")}
                    name="comment-policy"
                    value="original-and-translated"
                  />
                  <RadioCard
                    checked={commentPolicy === "translated"}
                    disabled={false}
                    label={t("translate.dialog.commentsTranslated")}
                    onChange={() => selectCommentPolicy("translated")}
                    description={t(
                      "translate.dialog.commentsTranslatedDescription",
                    )}
                    name="comment-policy"
                    value="translated"
                  />
                </fieldset>
              ) : null}
              {sameLanguage ? (
                <p className="text-destructive text-sm">
                  {t("bilingual.dialog.sameLanguage")}
                </p>
              ) : null}
            </div>
          )}
        </DialogPanel>

        <DialogFooter>
          <DialogClose
            render={<Button disabled={isStarting} variant="ghost" />}
          >
            {t("common.close")}
          </DialogClose>
          {!run || (!isRunning && run.status !== "completed") ? (
            <Button
              disabled={!canStart}
              onClick={() => translateMutation.mutate()}
            >
              {isStarting
                ? t("bilingualTranslate.review.starting")
                : t("common.translate")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
};

type RadioCardProps = {
  checked: boolean;
  disabled: boolean;
  label: string;
  description: string;
  name?: string | undefined;
  value: string;
  onChange: () => void;
};

const RadioCard = ({
  checked,
  disabled,
  label,
  description,
  name = "translation-choice",
  value,
  onChange,
}: RadioCardProps) => (
  <label
    aria-label={label}
    className="has-[:checked]:border-primary has-[:checked]:bg-muted/50 flex min-h-11 cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50"
  >
    <input
      checked={checked}
      className="accent-primary mt-0.5 size-4 shrink-0"
      disabled={disabled}
      name={name}
      onChange={onChange}
      type="radio"
      value={value}
    />
    <span className="flex min-w-0 flex-col gap-0.5">
      <span className="text-sm font-medium">{label}</span>
      <span className="text-muted-foreground text-xs">{description}</span>
    </span>
  </label>
);

/**
 * Bilingual-translation trigger + dialog.
 *
 * Mounted next to the bilingual-version action on the DOCX viewer. Fills the
 * right-hand column of a two-column document: pick the languages, review what
 * happens to every row and how the defined terms are rendered, then follow the
 * run that writes the filled document back as a new version.
 */

import { useState, type ReactNode } from "react";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import { panic } from "better-result";
import { BookOpenCheckIcon } from "lucide-react";
import { useTranslations } from "use-intl";

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
  BilingualReviewGlossary,
  glossaryDraftsFrom,
  glossaryIssue,
  toGlossaryEntries,
  type GlossaryDraft,
} from "@/components/bilingual-review-glossary";
import { BilingualReviewRows } from "@/components/bilingual-review-rows";
import { BilingualRunPanel } from "@/components/bilingual-run-panel";
import {
  BILINGUAL_FORMS_MAX,
  createBilingualRun,
  prepareBilingualTranslation,
  type BilingualPreparedRow,
  type BilingualRowDisposition,
} from "@/components/bilingual-translate-queries";
import { DocumentLanguagePicker } from "@/components/document-language-picker";
import { defaultLanguagePair } from "@/components/document-language-picker.logic";
import { useLocale } from "@/i18n/formatting-context";
import { useAnalytics } from "@/lib/analytics/provider";
import type { DeepLTargetLanguageCode } from "@/lib/deepl/languages";
import { detached } from "@/lib/detached";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { entitiesKeys } from "@/lib/workspaces/queries/entities";

type BilingualTranslateDialogProps = {
  workspaceId: string;
  entityId: string;
  fieldId: string;
  /** Disable when the underlying field is missing or not a DOCX. */
  disabled?: boolean | undefined;
};

/** The preparation the reviewer is editing, before any run exists. */
type BilingualReviewState = {
  step: "review";
  entityVersionId: string;
  droppedRows: number;
  rows: BilingualPreparedRow[];
  glossary: GlossaryDraft[];
};

/**
 * Where the dialog stands. The `run` branch carries only the run's id: the run
 * itself is durable server-side and is read back from there rather than
 * mirrored here.
 */
type BilingualTranslateState =
  | { step: "pick" }
  | BilingualReviewState
  | { step: "run"; runId: string };

export const BilingualTranslateDialog = ({
  workspaceId,
  entityId,
  fieldId,
  disabled = false,
}: BilingualTranslateDialogProps) => {
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
  const [state, setState] = useState<BilingualTranslateState>({ step: "pick" });

  const reportFailure = (error: unknown, title: string) => {
    analytics.captureError(error);
    stellaToast.add({
      title,
      description: userErrorFromThrown(error, t("errors.actionFailed")),
      type: "error",
    });
  };

  const prepareMutation = useMutation({
    mutationFn: async () =>
      await prepareBilingualTranslation({
        workspaceId,
        entityId,
        fieldId,
        sourceLang,
        targetLang,
      }),
    onSuccess: (preparation) => {
      setState({
        step: "review",
        entityVersionId: preparation.entityVersionId,
        droppedRows: preparation.droppedRows,
        rows: preparation.rows,
        glossary: glossaryDraftsFrom(preparation.glossary),
      });
    },
    onError: (error: unknown) => {
      reportFailure(error, t("bilingualTranslate.error.prepareTitle"));
    },
  });

  const runMutation = useMutation({
    mutationFn: async (review: BilingualReviewState) =>
      await createBilingualRun({
        workspaceId,
        entityId,
        fieldId,
        entityVersionId: review.entityVersionId,
        sourceLang,
        targetLang,
        glossary: toGlossaryEntries(review.glossary),
        rows: review.rows.map((row) => ({
          rowId: row.rowId,
          disposition: row.disposition,
        })),
      }),
    onSuccess: ({ runId }) => {
      setState({ step: "run", runId });
    },
    onError: (error: unknown) => {
      reportFailure(error, t("bilingualTranslate.error.startTitle"));
    },
  });

  // The run wrote a new version of the same document, so the reader only has
  // to re-read the entity it is already on.
  const openDocument = () => {
    detached(
      queryClient.invalidateQueries({
        queryKey: entitiesKeys.all(workspaceId),
      }),
      "bilingual-translate-dialog.invalidate",
    );
    detached(
      navigate({
        to: "/workspaces/$workspaceId/$viewId/document",
        params: { workspaceId, viewId },
        search: { entity: entityId, field: fieldId },
      }),
      "bilingual-translate-dialog.navigate",
    );
    setState({ step: "pick" });
    setOpen(false);
  };

  const setDisposition = (
    rowId: string,
    disposition: BilingualRowDisposition,
  ) => {
    setState((current) =>
      current.step === "review"
        ? {
            ...current,
            rows: current.rows.map((row) =>
              row.rowId === rowId ? { ...row, disposition } : row,
            ),
          }
        : current,
    );
  };

  const setGlossary = (glossary: GlossaryDraft[]) => {
    setState((current) =>
      current.step === "review" ? { ...current, glossary } : current,
    );
  };

  const renderStep = (): ReactNode => {
    switch (state.step) {
      case "pick":
        return (
          <BilingualPickStep
            onPrepare={() => prepareMutation.mutate()}
            onSourceLangChange={setSourceLang}
            onTargetLangChange={setTargetLang}
            pending={prepareMutation.isPending}
            sourceLang={sourceLang}
            targetLang={targetLang}
          />
        );
      case "review":
        return (
          <BilingualReviewStep
            onDispositionChange={setDisposition}
            onGlossaryChange={setGlossary}
            onStart={() => runMutation.mutate(state)}
            pending={runMutation.isPending}
            review={state}
          />
        );
      case "run":
        return (
          <BilingualRunPanel
            onOpenDocument={openDocument}
            onRestart={() => setState({ step: "pick" })}
            runId={state.runId}
            workspaceId={workspaceId}
          />
        );
      default:
        state satisfies never;
        return panic(`Unhandled state: ${String(state)}`);
    }
  };

  return (
    <Dialog onOpenChange={setOpen} open={open}>
      <DialogTrigger
        render={
          <Button
            aria-label={t("bilingualTranslate.dialog.title")}
            disabled={disabled}
            size="icon-xs"
            tooltip={t("bilingualTranslate.dialog.title")}
            variant="ghost"
          >
            <BookOpenCheckIcon className="size-3.5" />
          </Button>
        }
      />
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("bilingualTranslate.dialog.title")}</DialogTitle>
          <DialogDescription>
            {t("bilingualTranslate.dialog.description")}
          </DialogDescription>
        </DialogHeader>
        {renderStep()}
      </DialogPopup>
    </Dialog>
  );
};

type BilingualPickStepProps = {
  sourceLang: DeepLTargetLanguageCode;
  targetLang: DeepLTargetLanguageCode;
  pending: boolean;
  onSourceLangChange: (code: DeepLTargetLanguageCode) => void;
  onTargetLangChange: (code: DeepLTargetLanguageCode) => void;
  onPrepare: () => void;
};

const BilingualPickStep = ({
  sourceLang,
  targetLang,
  pending,
  onSourceLangChange,
  onTargetLangChange,
  onPrepare,
}: BilingualPickStepProps) => {
  const t = useTranslations();
  const sameLanguage = sourceLang === targetLang;

  return (
    <>
      <DialogPanel>
        <div className="flex flex-col gap-4">
          <DocumentLanguagePicker
            disabled={pending}
            id="bilingual-translate-source"
            label={t("bilingual.dialog.sourceLanguage")}
            onChange={onSourceLangChange}
            value={sourceLang}
          />
          <DocumentLanguagePicker
            disabled={pending}
            id="bilingual-translate-target"
            label={t("translate.dialog.targetLanguage")}
            onChange={onTargetLangChange}
            value={targetLang}
          />
          {sameLanguage && (
            <p className="text-destructive text-sm">
              {t("bilingual.dialog.sameLanguage")}
            </p>
          )}
          <p className="text-muted-foreground text-xs">
            {t("bilingualTranslate.dialog.preparingHint")}
          </p>
        </div>
      </DialogPanel>
      <DialogFooter>
        <DialogClose render={<Button variant="ghost" />}>
          {t("common.cancel")}
        </DialogClose>
        <Button disabled={sameLanguage} loading={pending} onClick={onPrepare}>
          {pending
            ? t("bilingualTranslate.dialog.preparing")
            : t("bilingualTranslate.dialog.prepare")}
        </Button>
      </DialogFooter>
    </>
  );
};

type BilingualReviewStepProps = {
  review: BilingualReviewState;
  pending: boolean;
  onDispositionChange: (
    rowId: string,
    disposition: BilingualRowDisposition,
  ) => void;
  onGlossaryChange: (glossary: GlossaryDraft[]) => void;
  onStart: () => void;
};

const BilingualReviewStep = ({
  review,
  pending,
  onDispositionChange,
  onGlossaryChange,
  onStart,
}: BilingualReviewStepProps) => {
  const t = useTranslations();
  const issue = glossaryIssue(review.glossary);

  return (
    <>
      <DialogPanel>
        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">
              {t("bilingualTranslate.rows.title")}
            </h3>
            <p className="text-muted-foreground text-xs">
              {t("bilingualTranslate.rows.description")}
            </p>
            <BilingualReviewRows
              disabled={pending}
              onDispositionChange={onDispositionChange}
              rows={review.rows}
            />
            {review.droppedRows > 0 && (
              <p className="text-muted-foreground text-xs">
                {t("bilingualTranslate.review.droppedRows", {
                  count: review.droppedRows,
                })}
              </p>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">
              {t("bilingualTranslate.glossary.title")}
            </h3>
            <p className="text-muted-foreground text-xs">
              {t("bilingualTranslate.glossary.description")}
            </p>
            <BilingualReviewGlossary
              disabled={pending}
              drafts={review.glossary}
              onChange={onGlossaryChange}
            />
          </section>
        </div>
      </DialogPanel>
      <DialogFooter>
        {issue !== null && (
          <p className="text-destructive me-auto self-center text-xs">
            {issue === "incomplete"
              ? t("bilingualTranslate.glossary.incomplete")
              : t("bilingualTranslate.glossary.tooManyForms", {
                  max: String(BILINGUAL_FORMS_MAX),
                })}
          </p>
        )}
        <DialogClose render={<Button variant="ghost" />}>
          {t("common.cancel")}
        </DialogClose>
        <Button disabled={issue !== null} loading={pending} onClick={onStart}>
          {pending
            ? t("bilingualTranslate.review.starting")
            : t("bilingualTranslate.review.start")}
        </Button>
      </DialogFooter>
    </>
  );
};

import { useState } from "react";

import { useTranslations } from "use-intl";

import {
  CASE_LAW_RESEARCH_ANSWER_TYPES,
  CASE_LAW_RESEARCH_QUESTION_MAX_LENGTH,
} from "@stll/api-contract";
import type { CaseLawResearchAnswerType } from "@stll/api-contract";
import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { Textarea } from "@stll/ui/textarea";

import type { TranslationKey } from "@/i18n/types";

export const ANSWER_TYPE_LABEL_KEYS = {
  yes_no: "caseLaw.research.answerTypeYesNo",
  text: "caseLaw.research.answerTypeText",
} as const satisfies Record<CaseLawResearchAnswerType, TranslationKey>;

const isAnswerType = (value: string): value is CaseLawResearchAnswerType =>
  CASE_LAW_RESEARCH_ANSWER_TYPES.some((type) => type === value);

export type ResearchQuestionDraft = {
  question: string;
  answerType: CaseLawResearchAnswerType;
};

type ResearchQuestionDialogProps = {
  /** The column being edited; absent when adding one. */
  initial?: ResearchQuestionDraft | undefined;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (draft: ResearchQuestionDraft) => void;
  open: boolean;
};

/**
 * Asks for the wording of a question and what kind of answer it takes. Editing
 * an existing question warns that its answers will be recomputed, because the
 * server drops them the moment the wording changes.
 */
export const ResearchQuestionDialog = ({
  initial,
  isPending,
  onOpenChange,
  onSubmit,
  open,
}: ResearchQuestionDialogProps) => {
  const t = useTranslations();
  const [question, setQuestion] = useState(initial?.question ?? "");
  const [answerType, setAnswerType] = useState<CaseLawResearchAnswerType>(
    initial?.answerType ?? "yes_no",
  );
  const trimmed = question.trim();
  const editing = initial !== undefined;

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {editing
              ? t("caseLaw.research.editQuestion")
              : t("caseLaw.research.addQuestion")}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? t("caseLaw.research.editQuestionHint")
              : t("caseLaw.research.addQuestionHint")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4 px-6 pb-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (trimmed.length === 0) {
              return;
            }
            onSubmit({ question: trimmed, answerType });
          }}
        >
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted-foreground">
              {t("caseLaw.research.question")}
            </span>
            <Textarea
              autoFocus
              maxLength={CASE_LAW_RESEARCH_QUESTION_MAX_LENGTH}
              onChange={(event) => setQuestion(event.currentTarget.value)}
              placeholder={t("caseLaw.research.questionPlaceholder")}
              rows={3}
              value={question}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="text-muted-foreground">
              {t("caseLaw.research.answerType")}
            </span>
            <Select
              onValueChange={(value: string | null) => {
                if (value !== null && isAnswerType(value)) {
                  setAnswerType(value);
                }
              }}
              value={answerType}
            >
              <SelectTrigger className="w-full sm:w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {CASE_LAW_RESEARCH_ANSWER_TYPES.map((type) => (
                  <SelectItem key={type} value={type}>
                    {t(ANSWER_TYPE_LABEL_KEYS[type])}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </label>
          <DialogFooter className="px-0">
            <DialogClose render={<Button variant="outline" />}>
              {t("common.cancel")}
            </DialogClose>
            <Button disabled={trimmed.length === 0 || isPending} type="submit">
              {editing ? t("common.save") : t("caseLaw.research.addQuestion")}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
};

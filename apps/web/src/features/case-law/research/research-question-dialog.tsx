import { useForm } from "@tanstack/react-form";
import { useSelector } from "@tanstack/react-store";
import { useTranslations } from "use-intl";
import * as v from "valibot";

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
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { Field, FieldError } from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import { Textarea } from "@stll/ui/textarea";

import {
  COMPOSER_CARD_CLASS,
  TypeChipsRow,
} from "@/components/workspaces/properties/composer-primitives";
import type { ChipDefinition } from "@/components/workspaces/properties/composer-primitives";
import { answerTypeMeta } from "@/features/case-law/research/answer-type";
import { questionEditDiscardsAnswers } from "@/features/case-law/research/question-columns.logic";
import type { QuestionDraft } from "@/features/case-law/research/question-columns.logic";
import { detached } from "@/lib/detached";
import { schemaFormOptions, toFormErrors } from "@/lib/schema";

/** The format chips, named and iconed from the shared value-type registry. */
const useAnswerTypeChips =
  (): readonly ChipDefinition<CaseLawResearchAnswerType>[] => {
    const t = useTranslations();
    return CASE_LAW_RESEARCH_ANSWER_TYPES.map((type) => {
      const meta = answerTypeMeta(type);
      return { type, icon: meta.icon, label: t(meta.labelKey) };
    });
  };

type ResearchQuestionDialogProps = {
  /** The column being edited; absent when adding one. */
  initial?: QuestionDraft | undefined;
  isPending: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (draft: QuestionDraft) => void;
  open: boolean;
};

/**
 * Asks for the wording of a question and what kind of answer it takes.
 *
 * The same composer the matter table opens for an AI column: one card holding
 * the instruction and the format chips, and the dialog's own footer band. A
 * question column has no matter behind it, so the reading-from row and the
 * prompt suggestion the matter card offers have nothing to work from and are
 * not drawn.
 */
export const ResearchQuestionDialog = ({
  initial,
  isPending,
  onOpenChange,
  onSubmit,
  open,
}: ResearchQuestionDialogProps) => {
  const t = useTranslations();
  const chipDefs = useAnswerTypeChips();
  const editing = initial !== undefined;

  const schema = v.strictObject({
    question: v.pipe(
      v.string(),
      v.trim(),
      v.nonEmpty(t("common.required")),
      v.maxLength(CASE_LAW_RESEARCH_QUESTION_MAX_LENGTH),
    ),
    answerType: v.picklist(CASE_LAW_RESEARCH_ANSWER_TYPES),
  });

  const form = useForm(
    schemaFormOptions({
      schema,
      submitValues: "schema-output",
      defaultValues: {
        question: initial?.question ?? "",
        answerType: initial?.answerType ?? "yes_no",
      },
      onSubmit: ({ value }) => {
        onSubmit(value);
      },
    }),
  );
  const formErrors = useSelector(form.store, (state) =>
    toFormErrors(state.fieldMeta),
  );

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogPopup className="sm:max-w-[640px]">
        <Form
          className="gap-0"
          errors={formErrors}
          onSubmit={(event) => {
            event.preventDefault();
            detached(form.handleSubmit(), "research-question-dialog.submit");
          }}
        >
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

          <DialogPanel>
            <div className={COMPOSER_CARD_CLASS}>
              <form.Field name="question">
                {(field) => (
                  <Field name={field.name}>
                    <Textarea
                      aria-label={t("caseLaw.research.question")}
                      autoFocus
                      className="text-foreground placeholder:text-foreground-placeholder w-full px-0 text-[15px] font-semibold tracking-tight"
                      maxLength={CASE_LAW_RESEARCH_QUESTION_MAX_LENGTH}
                      onBlur={field.handleBlur}
                      onChange={(event) =>
                        field.handleChange(event.currentTarget.value)
                      }
                      placeholder={t("caseLaw.research.questionPlaceholder")}
                      unstyled
                      value={field.state.value}
                    />
                    <FieldError />
                  </Field>
                )}
              </form.Field>

              <form.Field name="answerType">
                {(field) => (
                  <form.Subscribe selector={(state) => state.values.question}>
                    {(question) => (
                      <TypeChipsRow
                        chipDefs={chipDefs}
                        contentType={field.state.value}
                        onContentTypeChange={field.handleChange}
                        showSeparator
                        typeChanged={questionEditDiscardsAnswers({
                          draft: { answerType: field.state.value, question },
                          stored: initial,
                        })}
                      />
                    )}
                  </form.Subscribe>
                )}
              </form.Field>
            </div>
          </DialogPanel>

          <DialogFooter>
            <DialogClose render={<Button size="sm" variant="ghost" />}>
              {t("common.cancel")}
            </DialogClose>
            <Button loading={isPending} size="sm" type="submit">
              {editing ? t("common.save") : t("caseLaw.research.addQuestion")}
            </Button>
          </DialogFooter>
        </Form>
      </DialogPopup>
    </Dialog>
  );
};

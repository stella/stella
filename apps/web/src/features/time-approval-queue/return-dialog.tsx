import { useId } from "react";

import { useForm } from "@tanstack/react-form";
import { useSelector } from "@tanstack/react-store";
import { panic } from "better-result";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { Field, FieldError, FieldLabel } from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import { Textarea } from "@stll/ui/textarea";

import type { ApprovalEntry } from "@/features/time-approval-queue/queries";
import { detached } from "@/lib/detached";
import { schemaFormOptions, toFormErrors } from "@/lib/schema";

import {
  RETURN_COMMENT_MAX_LENGTH,
  validateReturnComment,
} from "./approval-state";

type ReturnDialogProps = {
  entry: ApprovalEntry | null;
  pending: boolean;
  onClose: () => void;
  onReturn: (comment: string) => void;
};
const ReturnCommentForm = ({
  pending,
  onClose,
  onReturn,
}: Omit<ReturnDialogProps, "entry">) => {
  const t = useTranslations();
  const id = useId();
  const form = useForm(
    schemaFormOptions({
      schema: v.object({
        comment: v.pipe(
          v.string(),
          v.rawTransform(({ dataset, addIssue, NEVER }) => {
            const result = validateReturnComment(dataset.value);
            switch (result.status) {
              case "valid":
                return result.comment;
              case "invalid":
                addIssue({ message: t(result.key) });
                return NEVER;
              default:
                result satisfies never;
                return panic("Unknown return comment state");
            }
          }),
        ),
      }),
      submitValues: "schema-output",
      defaultValues: { comment: "" },
      onSubmit: ({ value }) => {
        if (!pending) {
          onReturn(value.comment);
        }
      },
    }),
  );
  const errors = useSelector(form.store, (state) =>
    toFormErrors(state.fieldMeta),
  );
  return (
    <Form
      errors={errors}
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) {
          detached(form.handleSubmit(), "approval-queue.return-comment");
        }
      }}
    >
      <DialogPanel>
        <form.Field name="comment">
          {(field) => (
            <Field name={field.name}>
              <FieldLabel htmlFor={id}>
                {t("billing.approvalQueue.returnComment")}
              </FieldLabel>
              <Textarea
                id={id}
                autoFocus
                disabled={pending}
                maxLength={RETURN_COMMENT_MAX_LENGTH}
                rows={5}
                onBlur={field.handleBlur}
                onChange={(event) =>
                  field.handleChange(event.currentTarget.value)
                }
                value={field.state.value}
              />
              <FieldError />
            </Field>
          )}
        </form.Field>
      </DialogPanel>
      <DialogFooter>
        <Button
          disabled={pending}
          type="button"
          variant="outline"
          onClick={onClose}
        >
          {t("common.cancel")}
        </Button>
        <Button disabled={pending} type="submit">
          {t("billing.approvalQueue.returnEntry")}
        </Button>
      </DialogFooter>
    </Form>
  );
};

export const ReturnDialog = ({
  entry,
  pending,
  onClose,
  onReturn,
}: ReturnDialogProps) => {
  const t = useTranslations();
  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open && !pending) {
          onClose();
        }
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{t("billing.approvalQueue.returnEntry")}</DialogTitle>
        </DialogHeader>
        {entry !== null && (
          <ReturnCommentForm
            key={entry.id}
            pending={pending}
            onClose={onClose}
            onReturn={onReturn}
          />
        )}
      </DialogPopup>
    </Dialog>
  );
};

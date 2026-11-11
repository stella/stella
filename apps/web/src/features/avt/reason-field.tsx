/**
 * The reason a reviewer gives for an action that changes a claim's verdict,
 * asked for inline beside that action: a field that grows with the reason,
 * Enter records it (Shift+Enter breaks the line), Escape steps back, and a
 * missing reason is said next to the field.
 */

import * as React from "react";

import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Field, FieldError, FieldLabel } from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import { Textarea } from "@stll/ui/textarea";

/** The field starts at two lines and grows to six before it scrolls. */
const REASON_FIRST_ROWS = 2;
const REASON_GROWN_ROWS = 6;

type ReasonFieldProps = {
  /** What the reason is for, as the field's label. */
  label: string;
  /** Names the action, as its confirm button. */
  submitLabel: string;
  disabled: boolean;
  onSubmit: (reason: string) => void;
  onCancel: () => void;
};

export const ReasonField = ({
  label,
  submitLabel,
  disabled,
  onSubmit,
  onCancel,
}: ReasonFieldProps) => {
  const t = useTranslations();
  const [reason, setReason] = React.useState("");
  const [missing, setMissing] = React.useState(false);

  return (
    <div className="bg-muted w-full rounded-md border p-2.5">
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = reason.trim();
          if (trimmed === "") {
            setMissing(true);
            return;
          }
          onSubmit(trimmed);
        }}
      >
        <Field className="w-full gap-1.5" invalid={missing}>
          <FieldLabel>{label}</FieldLabel>
          <Textarea
            autoFocus
            className="w-full"
            maxRows={REASON_GROWN_ROWS}
            onChange={(event) => {
              setReason(event.target.value);
              setMissing(false);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                onCancel();
                return;
              }
              // Enter records the reason; Shift+Enter, or Enter that ends an
              // input-method composition, stays in the text.
              if (
                event.key === "Enter" &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                event.currentTarget.form?.requestSubmit();
              }
            }}
            placeholder={t("avt.reason.placeholder")}
            rows={REASON_FIRST_ROWS}
            size="sm"
            value={reason}
          />
          {missing && <FieldError match>{t("avt.reason.required")}</FieldError>}
          <div className="flex items-center gap-1.5">
            <Button disabled={disabled} size="sm" type="submit">
              {submitLabel}
            </Button>
            <Button onClick={onCancel} size="sm" type="button" variant="ghost">
              {t("common.cancel")}
            </Button>
          </div>
        </Field>
      </Form>
    </div>
  );
};

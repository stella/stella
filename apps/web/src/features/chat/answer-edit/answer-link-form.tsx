import { useId } from "react";

import { useForm } from "@tanstack/react-form";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { CHAT_MESSAGE_EDIT_URL_MAX_LENGTH } from "@stll/api-contract/chat-message-revisions";
import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";

import { detached } from "@/lib/detached";
import { schemaFormOptions } from "@/lib/schema";

import type { AnswerFormatAction } from "./markdown-format.logic";

export const AnswerLinkForm = ({
  onAction,
  onCancel,
  disabled,
  existingUrl,
}: {
  onAction: (action: AnswerFormatAction) => void;
  onCancel: () => void;
  disabled: boolean;
  existingUrl?: string | undefined;
}) => {
  const t = useTranslations();
  const id = useId();
  const errorId = useId();
  const form = useForm(
    schemaFormOptions({
      schema: v.strictObject({
        url: v.pipe(
          v.string(),
          v.trim(),
          v.maxLength(
            CHAT_MESSAGE_EDIT_URL_MAX_LENGTH,
            t("chat.answerEdit.invalidUrl"),
          ),
          v.url(t("chat.answerEdit.invalidUrl")),
          v.regex(/^https?:\/\//u, t("chat.answerEdit.invalidUrl")),
        ),
      }),
      defaultValues: { url: existingUrl ?? "" },
      submitValues: "schema-output",
      onSubmit: ({ value }) => onAction({ format: "link", url: value.url }),
    }),
  );
  return (
    <form
      noValidate
      className="w-80 space-y-2 p-2"
      onSubmit={(event) => {
        event.preventDefault();
        detached(form.handleSubmit(), "answer-format.link");
      }}
    >
      <form.Field name="url">
        {(field) => (
          <>
            <label htmlFor={id}>{t("chat.answerEdit.linkAddress")}</label>
            <Input
              id={id}
              maxLength={CHAT_MESSAGE_EDIT_URL_MAX_LENGTH}
              aria-describedby={
                field.state.meta.errors.length > 0 ? errorId : undefined
              }
              ref={(node) => node?.focus()}
              value={field.state.value}
              disabled={disabled}
              onChange={(event) =>
                field.handleChange(event.currentTarget.value)
              }
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  onCancel();
                }
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  detached(form.handleSubmit(), "answer-format.link");
                }
              }}
              aria-invalid={field.state.meta.errors.length > 0}
            />
            {field.state.meta.errors.length > 0 && (
              <p id={errorId} role="alert">
                {t("chat.answerEdit.invalidUrl")}
              </p>
            )}
          </>
        )}
      </form.Field>
      <Button type="submit" size="sm" disabled={disabled}>
        {t("common.apply")}
      </Button>
      {existingUrl !== undefined && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled}
          onClick={() => onAction({ format: "link", url: existingUrl })}
        >
          {t("folio.removeLink")}
        </Button>
      )}
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
        {t("common.cancel")}
      </Button>
    </form>
  );
};

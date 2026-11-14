import { useId } from "react";

import { useForm } from "@tanstack/react-form";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import {
  CHAT_MESSAGE_EDIT_URL_MAX_LENGTH,
  CHAT_MESSAGE_LINK_INTENT,
} from "@stll/api-contract/chat-message-revisions";
import { Button } from "@stll/ui/button";
import { Form } from "@stll/ui/form";
import { Input } from "@stll/ui/input";
import { Label } from "@stll/ui/label";

import type { TranslationKey } from "@/i18n/types";
import { detached } from "@/lib/detached";
import { schemaFormOptions } from "@/lib/schema";

import type { AnswerFormatAction } from "./markdown-format.logic";

export const AnswerLinkForm = ({
  onAction,
  onCancel,
  disabled,
  existingUrl,
  removal,
}: {
  onAction: (action: AnswerFormatAction) => void;
  onCancel: () => void;
  disabled: boolean;
  existingUrl?: string | undefined;
  removal:
    | { status: "available" }
    | {
        status: "unavailable";
        reason: Extract<
          TranslationKey,
          "chat.answerEdit.autolinkLabel" | "chat.answerEdit.invalidSelection"
        >;
      };
}) => {
  const t = useTranslations();
  const id = useId();
  const errorId = useId();
  const removalReasonId = useId();
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
      onSubmit: ({ value }) => {
        if (value.url === existingUrl) {
          return;
        }
        onAction({
          format: "link",
          intent: CHAT_MESSAGE_LINK_INTENT.set,
          url: value.url,
        });
      },
    }),
  );
  return (
    <div className="w-80 p-2">
      <Form
        className="items-start gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          detached(form.handleSubmit(), "answer-format.link");
        }}
      >
        <form.Field name="url">
          {(field) => (
            <>
              <Label htmlFor={id}>{t("chat.answerEdit.linkAddress")}</Label>
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
        <div className="flex gap-2">
          <Button type="submit" size="sm" disabled={disabled}>
            {t("common.confirm")}
          </Button>
          {existingUrl !== undefined && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={disabled || removal.status === "unavailable"}
              aria-describedby={
                removal.status === "unavailable" ? removalReasonId : undefined
              }
              onClick={() =>
                onAction({
                  format: "link",
                  intent: CHAT_MESSAGE_LINK_INTENT.remove,
                })
              }
            >
              {t("folio.removeLink")}
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        </div>
        {existingUrl !== undefined && removal.status === "unavailable" && (
          <p id={removalReasonId}>{t(removal.reason)}</p>
        )}
      </Form>
    </div>
  );
};

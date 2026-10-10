import { useId, useRef, useState } from "react";

import { useForm } from "@tanstack/react-form";
import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import type { CHAT_ANSWER_EDIT_STATES } from "@stll/api-contract/chat-message-revisions";
import { CHAT_MESSAGE_EDIT_INSTRUCTION_MAX_LENGTH } from "@stll/api-contract/chat-message-revisions";
import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import { ReviewDecisionActions } from "@stll/ui/review-decision-actions";
import { ReviewDiffText } from "@stll/ui/review-diff-text";

import { useExternalSyncEffect, useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { APIError } from "@/lib/errors/api";
import { schemaFormOptions } from "@/lib/schema";

import { acceptAnswerEdit, requestAnswerEdit } from "./answer-edit-api";
import type { AnswerEditAnchor, AnswerEditProposal } from "./answer-edit-api";

export const AnswerEditPanel = ({
  anchor,
  threadId,
  disabled,
  onCancel,
  onAnswerEdited,
  request = requestAnswerEdit,
  accept = acceptAnswerEdit,
  initialProposal,
}: AnswerEditPanelProps) => {
  const t = useTranslations();
  const instructionId = useId();
  const validationId = useId();
  const [state, setState] = useState<EditState>(
    initialProposal === undefined
      ? { status: "instruction" }
      : { status: "proposal", proposal: initialProposal },
  );
  const active = useRef(true);
  const busy = useRef(false);
  const requestController = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  useExternalSyncEffect(() => {
    if (state.status !== "instruction") {
      panelRef.current?.focus();
    }
  }, [state.status]);
  useMountEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      requestController.current?.abort();
    };
  });
  const refreshAnswer = async () => {
    const refreshed = await Result.tryPromise({
      try: onAnswerEdited,
      catch: (error) => error,
    });
    if (Result.isOk(refreshed)) {
      return true;
    }
    getAnalytics().captureError(refreshed.error);
    if (active.current) {
      setState({ status: "stale" });
    }
    return false;
  };
  const submitInstruction = useLatestCallback(async (instruction: string) => {
    if (disabled || busy.current) {
      return;
    }
    busy.current = true;
    const controller = new AbortController();
    requestController.current = controller;
    setState({ status: "requesting" });
    const result = await request({
      threadId,
      anchor,
      instruction,
      signal: controller.signal,
    });
    busy.current = false;
    requestController.current = null;
    if (!active.current || controller.signal.aborted) {
      return;
    }
    if (Result.isOk(result)) {
      setState({ status: "proposal", proposal: result.value });
      return;
    }
    getAnalytics().captureError(result.error);
    if (APIError.is(result.error) && result.error.status === 409) {
      setState({ status: "stale" });
      await refreshAnswer();
      return;
    }
    setState({ status: "instruction", error: t("chat.answerEdit.failed") });
  });
  const form = useForm(
    schemaFormOptions({
      schema: v.strictObject({
        instruction: v.pipe(
          v.string(),
          v.trim(),
          v.nonEmpty(t("chat.answerEdit.instructionRequired")),
          v.maxLength(CHAT_MESSAGE_EDIT_INSTRUCTION_MAX_LENGTH),
        ),
      }),
      defaultValues: { instruction: "" },
      submitValues: "schema-output",
      onSubmit: async ({ value }) => await submitInstruction(value.instruction),
    }),
  );
  const save = async (proposal: AnswerEditProposal) => {
    if (disabled || busy.current) {
      return;
    }
    busy.current = true;
    setState({ status: "accepting", proposal });
    const result = await accept({ threadId, anchor, proposal });
    busy.current = false;
    if (Result.isOk(result)) {
      if ((await refreshAnswer()) && active.current) {
        onCancel();
      }
      return;
    }
    if (!active.current) {
      return;
    }
    getAnalytics().captureError(result.error);
    if (APIError.is(result.error) && result.error.status === 409) {
      setState({ status: "stale" });
      await refreshAnswer();
      return;
    }
    setState({
      status: "proposal",
      proposal,
      error: t("chat.answerEdit.acceptFailed"),
    });
  };
  const cancelPanel = useLatestCallback(() => {
    requestController.current?.abort();
    onCancel();
  });
  const onPanelKeyDown = useLatestCallback((event: KeyboardEvent) => {
    if (event.key !== "Escape" || state.status === "accepting") {
      return;
    }
    event.preventDefault();
    cancelPanel();
  });
  return (
    <div
      className="w-80 max-w-full space-y-2 p-2"
      ref={(node) => {
        panelRef.current = node;
        if (node === null) {
          return undefined;
        }
        node.addEventListener("keydown", onPanelKeyDown);
        return () => node.removeEventListener("keydown", onPanelKeyDown);
      }}
      tabIndex={-1}
      role="dialog"
      aria-label={t("chat.answerEdit.ask")}
    >
      {(() => {
        switch (state.status) {
          case "instruction":
            return (
              <form
                noValidate
                onSubmit={(event) => {
                  event.preventDefault();
                  detached(form.handleSubmit(), "answer-edit.submit");
                }}
                className="space-y-2"
              >
                <form.Field name="instruction">
                  {(field) => (
                    <div className="space-y-1">
                      <label className="block text-sm" htmlFor={instructionId}>
                        {t("chat.answerEdit.instruction")}
                      </label>
                      <Input
                        id={instructionId}
                        ref={(node) => node?.focus()}
                        maxLength={CHAT_MESSAGE_EDIT_INSTRUCTION_MAX_LENGTH}
                        value={field.state.value}
                        disabled={disabled}
                        onChange={(event) =>
                          field.handleChange(event.currentTarget.value)
                        }
                        onBlur={field.handleBlur}
                        onKeyDown={(event) => {
                          if (
                            event.key !== "Enter" ||
                            event.nativeEvent.isComposing
                          ) {
                            return;
                          }
                          event.preventDefault();
                          detached(form.handleSubmit(), "answer-edit.submit");
                        }}
                        aria-invalid={field.state.meta.errors.length > 0}
                        aria-describedby={
                          field.state.meta.errors.length > 0
                            ? validationId
                            : undefined
                        }
                      />
                      {field.state.meta.errors.length > 0 && (
                        <p id={validationId} role="alert">
                          {t("chat.answerEdit.instructionRequired")}
                        </p>
                      )}
                    </div>
                  )}
                </form.Field>
                {state.error && <p role="alert">{state.error}</p>}
                <div className="flex gap-2">
                  <Button size="sm" type="submit" disabled={disabled}>
                    {t("chat.answerEdit.submit")}
                  </Button>
                  <Button
                    size="sm"
                    type="button"
                    variant="ghost"
                    onClick={cancelPanel}
                  >
                    {t("common.cancel")}
                  </Button>
                </div>
              </form>
            );
          case "requesting":
          case "stale":
            return (
              <AnswerEditNotice status={state.status} onCancel={cancelPanel} />
            );
          case "proposal":
          case "accepting":
            return (
              <AnswerEditProposalReview
                original={anchor.selectedSource}
                replacement={state.proposal.replacement}
                status={state.status}
                disabled={disabled}
                error={state.status === "proposal" ? state.error : undefined}
                onAccept={() =>
                  detached(save(state.proposal), "answer-edit.accept")
                }
                onCancel={cancelPanel}
              />
            );
          default:
            state satisfies never;
            return panic(`Unhandled answer edit state: ${String(state)}`);
        }
      })()}
    </div>
  );
};

type EditState =
  | { status: "instruction"; error?: string }
  | { status: "requesting" }
  | { status: "proposal"; proposal: AnswerEditProposal; error?: string }
  | { status: "accepting"; proposal: AnswerEditProposal }
  | { status: "stale" };

true satisfies Exclude<
  EditState["status"],
  (typeof CHAT_ANSWER_EDIT_STATES)[number]
> extends never
  ? true
  : never;
true satisfies Exclude<
  (typeof CHAT_ANSWER_EDIT_STATES)[number],
  EditState["status"]
> extends never
  ? true
  : never;

type AnswerEditPanelProps = {
  anchor: AnswerEditAnchor;
  threadId: string;
  disabled: boolean;
  onCancel: () => void;
  onAnswerEdited: () => Promise<void>;
  initialProposal?: AnswerEditProposal | undefined;
  request?: typeof requestAnswerEdit;
  accept?: typeof acceptAnswerEdit;
};

type AnswerEditProposalReviewProps = {
  original: string;
  replacement: string;
  status: "proposal" | "accepting";
  disabled: boolean;
  error?: string | undefined;
  onAccept: () => void;
  onCancel: () => void;
};

export const AnswerEditProposalReview = ({
  original,
  replacement,
  status,
  disabled,
  error,
  onAccept,
  onCancel,
}: AnswerEditProposalReviewProps) => {
  const t = useTranslations();
  return (
    <div className="space-y-2">
      <p className="font-medium">{t("chat.answerEdit.proposal")}</p>
      <ReviewDiffText
        className="wrap-break-word whitespace-pre-wrap"
        segments={[
          { type: "delete", text: original },
          { type: "insert", text: replacement },
        ]}
      />
      {error && <p role="alert">{error}</p>}
      <ReviewDecisionActions
        state={status === "accepting" ? "applying" : "pending"}
        disabled={disabled}
        acceptLabel={t("common.accept")}
        rejectLabel={t("common.undo")}
        onAccept={onAccept}
        onReject={onCancel}
      />
    </div>
  );
};

export const AnswerEditNotice = ({
  status,
  onCancel,
}: {
  status: "requesting" | "stale";
  onCancel: () => void;
}) => {
  const t = useTranslations();
  switch (status) {
    case "requesting":
      return (
        <>
          <p role="status">{t("chat.answerEdit.requesting")}</p>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        </>
      );
    case "stale":
      return (
        <>
          <p role="alert">{t("chat.answerEdit.stale")}</p>
          <Button size="sm" variant="ghost" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        </>
      );
    default:
      status satisfies never;
      return panic(`Unhandled answer edit notice: ${String(status)}`);
  }
};

import type { ComponentProps } from "react";
import { useState } from "react";

import { useTranslations } from "use-intl";

import {
  answersInOwnWords,
  canSubmitLocalRunAnswers,
  EMPTY_LOCAL_RUN_QUESTION_DRAFT,
  localRunAnswerOf,
  localRunAnswersOf,
  type LocalRunQuestionDraft,
  type LocalRunQuestionPause,
  toggleLocalRunOption,
} from "@stll/api-contract/chat-local-run-question";
import type { ChatLocalRunQuestion } from "@stll/api-contract/chat-run-target";
import { Button } from "@stll/ui/button";
import { Form } from "@stll/ui/form";
import { HelpCircleIcon, PencilIcon } from "@stll/ui/icons";
import { Input } from "@stll/ui/input";
import { Loader } from "@stll/ui/loader";
import { Step, Steps } from "@stll/ui/steps";
import { contentDir } from "@stll/ui/use-content-dir";
import { cn } from "@stll/ui/utils";

import { SecretInput } from "@/components/secret-input";
import {
  useFormattingLocale,
  useStepsMarkerStyle,
} from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";

type LocalRunQuestionCardProps = {
  pause: LocalRunQuestionPause;
  /** Answer the pause, or dismiss it with `null`; see `answerLocalRunQuestion`. */
  onAnswer: (
    interruptId: string,
    answers: Record<string, string[]> | null,
  ) => Promise<void>;
};

type Sent = { type: "answered" } | { type: "dismissed" } | null;

/**
 * A blocking question a coding agent on the member's computer asked, shown
 * like the cloud ask-user card: each question with its options, the member's
 * own words where the agent takes them, and a secret's answer masked and
 * never shown back. Submit resumes the paused turn with the answers; Dismiss
 * resumes it cancelled, which stops the agent's turn.
 */
export const LocalRunQuestionCard = ({
  pause,
  onAnswer,
}: LocalRunQuestionCardProps) => {
  const t = useTranslations();
  const formattingLocale = useFormattingLocale();
  const markerStyle = useStepsMarkerStyle();
  const [drafts, setDrafts] = useState<Record<string, LocalRunQuestionDraft>>(
    {},
  );
  const [sent, setSent] = useState<Sent>(null);
  const { questions } = pause;
  const canSubmit =
    sent === null && canSubmitLocalRunAnswers(questions, drafts);

  const draftOf = (question: ChatLocalRunQuestion): LocalRunQuestionDraft =>
    Object.hasOwn(drafts, question.id)
      ? (drafts[question.id] ?? EMPTY_LOCAL_RUN_QUESTION_DRAFT)
      : EMPTY_LOCAL_RUN_QUESTION_DRAFT;
  const updateDraft = (
    question: ChatLocalRunQuestion,
    next: (draft: LocalRunQuestionDraft) => LocalRunQuestionDraft,
  ) => {
    setDrafts((current) => ({
      ...current,
      [question.id]: next(
        Object.hasOwn(current, question.id)
          ? (current[question.id] ?? EMPTY_LOCAL_RUN_QUESTION_DRAFT)
          : EMPTY_LOCAL_RUN_QUESTION_DRAFT,
      ),
    }));
  };

  const send = (answers: Record<string, string[]> | null) => {
    setSent(answers === null ? { type: "dismissed" } : { type: "answered" });
    detached(
      onAnswer(pause.interruptId, answers),
      "local-run-question-card.answer",
    );
  };

  const handleSubmit: NonNullable<ComponentProps<"form">["onSubmit"]> = (
    event,
  ) => {
    event.preventDefault();
    if (!canSubmit) {
      return;
    }
    send(localRunAnswersOf(questions, drafts));
  };

  const isDone = sent !== null;

  return (
    <div
      className={cn(
        "my-1 rounded-lg border text-sm",
        isDone ? "bg-muted/40 border-transparent" : "border-border bg-muted/30",
      )}
      data-local-run-question={pause.interruptId}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <HelpCircleIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="font-medium">{t("chat.tool.ask-user")}</span>
        {/* Sent: the agent continues, or stops, on the member's computer. */}
        {sent !== null && (
          <Loader
            className="ms-auto size-3.5 shrink-0"
            label={t("common.loading")}
            size="sm"
          />
        )}
      </div>

      <Form onSubmit={handleSubmit}>
        {/* One child: the card's sections are divided by their own borders,
            so the form's gap between children would open a seam. */}
        <div>
          <div className="border-border/50 border-t px-3 py-3">
            <Steps lang={formattingLocale} markerStyle={markerStyle}>
              {questions.map((question) => {
                const draft = draftOf(question);
                const ownWords = answersInOwnWords(question, draft);
                const pickedDescriptions = question.options
                  .filter(
                    ({ label, description }) =>
                      description !== "" && draft.picked.includes(label),
                  )
                  .map(({ label, description }) => ({ label, description }));
                return (
                  <Step key={question.id}>
                    <div className="space-y-1.5">
                      {question.header !== "" && (
                        <p className="text-muted-foreground text-xs" dir="auto">
                          {question.header}
                        </p>
                      )}
                      <p className="text-xs font-medium" dir="auto">
                        {question.prompt}
                      </p>
                      {question.multiSelect &&
                        question.options.length > 0 &&
                        !ownWords && (
                          <p className="text-muted-foreground text-xs">
                            {t("chat.localRunQuestion.chooseSeveral")}
                          </p>
                        )}

                      {isDone ? (
                        <LocalRunQuestionSentAnswer
                          answers={
                            sent.type === "answered"
                              ? localRunAnswerOf(question, draft)
                              : []
                          }
                          question={question}
                        />
                      ) : (
                        <>
                          {!ownWords && (
                            <div className="flex flex-wrap gap-1.5">
                              {question.options.map((option) => {
                                const isPicked = draft.picked.includes(
                                  option.label,
                                );
                                return (
                                  <Button
                                    aria-pressed={isPicked}
                                    key={option.label}
                                    onClick={() =>
                                      updateDraft(question, (current) =>
                                        toggleLocalRunOption(
                                          question,
                                          current,
                                          option.label,
                                        ),
                                      )
                                    }
                                    selected={isPicked}
                                    size="xs"
                                    variant="outline"
                                  >
                                    <bdi>{option.label}</bdi>
                                  </Button>
                                );
                              })}
                              {question.allowsFreeText && (
                                <Button
                                  onClick={() =>
                                    updateDraft(question, (current) => ({
                                      ...current,
                                      ownWords: true,
                                    }))
                                  }
                                  size="xs"
                                  variant="outline"
                                >
                                  <PencilIcon className="size-2.5" />
                                  {t("chat.askUser.custom")}
                                </Button>
                              )}
                            </div>
                          )}
                          {!ownWords &&
                            pickedDescriptions.map(({ label, description }) => (
                              <p
                                className="text-muted-foreground text-xs"
                                dir="auto"
                                key={label}
                              >
                                {description}
                              </p>
                            ))}

                          {ownWords && (
                            <div className="flex gap-1.5">
                              {question.secret ? (
                                <SecretInput
                                  aria-label={question.prompt}
                                  autoComplete="off"
                                  className="flex-1"
                                  onChange={(event) => {
                                    const text = event.currentTarget.value;
                                    updateDraft(question, (current) => ({
                                      ...current,
                                      text,
                                    }));
                                  }}
                                  placeholder={t(
                                    "chat.localRunQuestion.secretPlaceholder",
                                  )}
                                  size="sm"
                                  value={draft.text}
                                />
                              ) : (
                                <Input
                                  aria-label={question.prompt}
                                  className="flex-1"
                                  dir={contentDir(draft.text)}
                                  onChange={(event) => {
                                    const text = event.currentTarget.value;
                                    updateDraft(question, (current) => ({
                                      ...current,
                                      text,
                                    }));
                                  }}
                                  placeholder={t("chat.askUser.placeholder")}
                                  size="sm"
                                  type="text"
                                  value={draft.text}
                                />
                              )}
                              {question.options.length > 0 && (
                                <Button
                                  onClick={() =>
                                    updateDraft(question, (current) => ({
                                      ...current,
                                      ownWords: false,
                                    }))
                                  }
                                  size="xs"
                                  variant="muted"
                                >
                                  A/B/C
                                </Button>
                              )}
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </Step>
                );
              })}
            </Steps>
          </div>

          {!isDone && (
            <div className="border-border/50 border-t px-3 py-2">
              <div className="flex items-center gap-2">
                <Button disabled={!canSubmit} size="xs" type="submit">
                  {t("chat.askUser.submit")}
                </Button>
                <Button onClick={() => send(null)} size="xs" variant="muted">
                  {t("chat.localRunQuestion.dismiss")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </Form>
    </div>
  );
};

/** What was sent for one question; a secret's answer is never shown back. */
const LocalRunQuestionSentAnswer = ({
  question,
  answers,
}: {
  question: ChatLocalRunQuestion;
  answers: readonly string[];
}) => {
  const t = useTranslations();
  if (answers.length === 0) {
    return (
      <p className="text-muted-foreground text-xs">
        {t("chat.askUser.noAnswer")}
      </p>
    );
  }
  if (question.secret) {
    return (
      <p className="text-muted-foreground text-xs">
        {t("chat.localRunQuestion.secretAnswer")}
      </p>
    );
  }
  return (
    <ul className="text-muted-foreground space-y-0.5 text-xs">
      {answers.map((answer) => (
        <li dir="auto" key={answer}>
          {answer}
        </li>
      ))}
    </ul>
  );
};

import { useState } from "react";

import { View } from "react-native";
import { useTranslations } from "use-intl";

import {
  answersInOwnWords,
  canSubmitLocalRunAnswers,
  EMPTY_LOCAL_RUN_QUESTION_DRAFT,
  localRunAnswersOf,
  type LocalRunQuestionDraft,
  type LocalRunQuestionPause,
  toggleLocalRunOption,
} from "@stll/api-contract/chat-local-run-question";
import type { ChatLocalRunQuestion } from "@stll/api-contract/chat-run-target";
import {
  getReadableInputRows,
  humanizeIdentifier,
} from "@stll/api-contract/chat-tool-input-rows";
import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import { Text } from "@stll/ui/text";

import type {
  PendingAnswer,
  PendingApproval,
  PendingInput,
} from "@/state/chat-pending-input";

/** Why the card's last answer did not continue the turn. */
export type InputNotice = "failed" | "answeredElsewhere";

/**
 * What a paused turn waits for, answered from the phone: the calls it asks
 * to run, allowed or denied, or the question a coding agent on the person's
 * computer asked, with its options and the person's own words. Input only
 * the web app can give is named as such. `busy` holds the card while an
 * answer is on its way.
 */
export const ChatInputCard = ({
  busy,
  notice,
  onAnswer,
  pending,
}: {
  busy: boolean;
  notice: InputNotice | undefined;
  onAnswer: (answer: PendingAnswer) => void;
  pending: PendingInput | null;
}) => {
  const t = useTranslations("chat");
  if (pending === null || pending.type === "elsewhere") {
    const said = [
      pending === null ? undefined : t("answerNeedsInput"),
      notice === "answeredElsewhere" ? t("answeredElsewhere") : undefined,
    ].filter((line) => line !== undefined);
    return said.length === 0 ? null : (
      <View className="gap-1 px-4">
        {said.map((line) => (
          <Text key={line} variant="caption">
            {line}
          </Text>
        ))}
      </View>
    );
  }
  return (
    <View className="border-border bg-card gap-3 rounded-xl border p-3">
      {notice === "answeredElsewhere" ? (
        // An earlier pause was answered elsewhere; this is the one after it.
        <Text variant="caption">{t("answeredElsewhere")}</Text>
      ) : null}
      {pending.type === "approvals" ? (
        <ApprovalsCard
          approvals={pending.approvals}
          busy={busy}
          // A new pause starts with nothing decided.
          key={pending.parentRunId}
          onAnswer={onAnswer}
        />
      ) : (
        <QuestionCard
          busy={busy}
          key={pending.pause.interruptId}
          onAnswer={onAnswer}
          pause={pending.pause}
        />
      )}
      {notice === "failed" ? (
        <Text variant="error">{t("answerSendFailed")}</Text>
      ) : null}
    </View>
  );
};

/**
 * The calls a turn asks to run. One call is answered with its button; for
 * several, each is decided and the decisions go together, as the server
 * takes them.
 */
const ApprovalsCard = ({
  approvals,
  busy,
  onAnswer,
}: {
  approvals: readonly PendingApproval[];
  busy: boolean;
  onAnswer: (answer: PendingAnswer) => void;
}) => {
  const t = useTranslations("chat");
  const [allowed, setAllowed] = useState<Readonly<Record<string, boolean>>>({});
  const single = approvals.length === 1;
  const decide = (interruptId: string, approved: boolean) => {
    const next = { ...allowed, [interruptId]: approved };
    if (single) {
      onAnswer({ type: "approvals", allowed: next });
      return;
    }
    setAllowed(next);
  };
  const decided = approvals.every(({ interruptId }) =>
    Object.hasOwn(allowed, interruptId),
  );

  return (
    <View className="gap-4">
      {approvals.map((approval) => (
        <ApprovalRow
          approval={approval}
          busy={busy}
          decision={
            Object.hasOwn(allowed, approval.interruptId)
              ? allowed[approval.interruptId]
              : undefined
          }
          key={approval.interruptId}
          onDecide={(approved) => {
            decide(approval.interruptId, approved);
          }}
        />
      ))}
      {single ? null : (
        <Button
          disabled={busy || !decided}
          loading={busy}
          onPress={() => {
            onAnswer({ type: "approvals", allowed });
          }}
        >
          {t("submitAnswers")}
        </Button>
      )}
    </View>
  );
};

/** One call to allow or deny: what it is, what it was given, and the two answers. */
const ApprovalRow = ({
  approval,
  busy,
  decision,
  onDecide,
}: {
  approval: PendingApproval;
  busy: boolean;
  decision: boolean | undefined;
  onDecide: (approved: boolean) => void;
}) => {
  const t = useTranslations("chat");
  const rows = getReadableInputRows({
    emptyLabel: t("inputEmpty"),
    input: approval.input,
    requestLabel: t("inputRequest"),
  });

  return (
    <View className="gap-2">
      <View className="gap-0.5">
        <Text variant="label">{t("approvalTitle")}</Text>
        <Text variant="caption">{humanizeIdentifier(approval.toolName)}</Text>
      </View>
      {rows.map((row) => (
        <View className="gap-0.5" key={row.key}>
          <Text variant="caption">{row.label}</Text>
          <Text selectable>{row.value}</Text>
        </View>
      ))}
      <View className="flex-row flex-wrap gap-2">
        <Button
          disabled={busy}
          onPress={() => {
            onDecide(true);
          }}
          selected={decision === true}
          size="sm"
          variant={decision === undefined ? "default" : "outline"}
        >
          {t("approvalAllowOnce")}
        </Button>
        <Button
          disabled={busy}
          onPress={() => {
            onDecide(false);
          }}
          selected={decision === false}
          size="sm"
          variant="outline"
        >
          {t("approvalDeny")}
        </Button>
      </View>
    </View>
  );
};

/**
 * A coding agent's blocking question, as the web's card asks it: each
 * question with its options, the person's own words where the agent takes
 * them, and a secret typed hidden. Submit continues the agent's turn with
 * the answers; Dismiss stops it.
 */
const QuestionCard = ({
  busy,
  onAnswer,
  pause,
}: {
  busy: boolean;
  onAnswer: (answer: PendingAnswer) => void;
  pause: LocalRunQuestionPause;
}) => {
  const t = useTranslations("chat");
  const [drafts, setDrafts] = useState<
    Readonly<Record<string, LocalRunQuestionDraft>>
  >({});
  const { questions } = pause;
  const draftOf = (question: ChatLocalRunQuestion): LocalRunQuestionDraft =>
    Object.hasOwn(drafts, question.id)
      ? (drafts[question.id] ?? EMPTY_LOCAL_RUN_QUESTION_DRAFT)
      : EMPTY_LOCAL_RUN_QUESTION_DRAFT;
  const update = (
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

  return (
    <View className="gap-4">
      <Text variant="label">{t("questionTitle")}</Text>
      {questions.map((question) => (
        <QuestionField
          busy={busy}
          draft={draftOf(question)}
          key={question.id}
          onChange={(next) => {
            update(question, next);
          }}
          question={question}
        />
      ))}
      <View className="flex-row flex-wrap gap-2">
        <Button
          disabled={busy || !canSubmitLocalRunAnswers(questions, drafts)}
          loading={busy}
          onPress={() => {
            onAnswer({
              type: "question",
              answers: localRunAnswersOf(questions, drafts),
            });
          }}
          size="sm"
        >
          {t("submitAnswers")}
        </Button>
        <Button
          disabled={busy}
          onPress={() => {
            onAnswer({ type: "question", answers: null });
          }}
          size="sm"
          variant="muted"
        >
          {t("questionDismiss")}
        </Button>
      </View>
    </View>
  );
};

/** One question: its options to pick, or a field for the person's own words. */
const QuestionField = ({
  busy,
  draft,
  onChange,
  question,
}: {
  busy: boolean;
  draft: LocalRunQuestionDraft;
  onChange: (
    next: (draft: LocalRunQuestionDraft) => LocalRunQuestionDraft,
  ) => void;
  question: ChatLocalRunQuestion;
}) => {
  const t = useTranslations("chat");
  const ownWords = answersInOwnWords(question, draft);
  const pickedDescriptions = question.options.filter(
    ({ description, label }) =>
      description !== "" && draft.picked.includes(label),
  );

  return (
    <View className="gap-2">
      {question.header === "" ? null : (
        <Text variant="caption">{question.header}</Text>
      )}
      <Text>{question.prompt}</Text>
      {question.multiSelect && question.options.length > 0 && !ownWords ? (
        <Text variant="caption">{t("questionChooseSeveral")}</Text>
      ) : null}
      {ownWords ? (
        <View className="gap-2">
          <Input
            accessibilityLabel={question.prompt}
            autoComplete="off"
            disabled={busy}
            onChangeText={(text) => {
              onChange((current) => ({ ...current, text }));
            }}
            placeholder={
              question.secret
                ? t("questionSecretPlaceholder")
                : t("questionPlaceholder")
            }
            secureTextEntry={question.secret}
            size="sm"
            value={draft.text}
          />
          {question.options.length > 0 ? (
            <Button
              className="self-start"
              disabled={busy}
              onPress={() => {
                onChange((current) => ({ ...current, ownWords: false }));
              }}
              size="sm"
              variant="muted"
            >
              {t("questionShowOptions")}
            </Button>
          ) : null}
        </View>
      ) : (
        <View className="flex-row flex-wrap gap-2">
          {question.options.map((option) => (
            <Button
              disabled={busy}
              key={option.label}
              onPress={() => {
                onChange((current) =>
                  toggleLocalRunOption(question, current, option.label),
                );
              }}
              selected={draft.picked.includes(option.label)}
              size="sm"
              variant="outline"
            >
              {option.label}
            </Button>
          ))}
          {question.allowsFreeText ? (
            <Button
              disabled={busy}
              onPress={() => {
                onChange((current) => ({ ...current, ownWords: true }));
              }}
              size="sm"
              variant="muted"
            >
              {t("questionOwnWords")}
            </Button>
          ) : null}
        </View>
      )}
      {ownWords
        ? null
        : pickedDescriptions.map(({ description, label }) => (
            <Text key={label} variant="caption">
              {description}
            </Text>
          ))}
    </View>
  );
};

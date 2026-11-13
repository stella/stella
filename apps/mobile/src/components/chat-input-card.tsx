import { useEffect, useEffectEvent, useState } from "react";

import { Result } from "better-result";
import { View } from "react-native";
import { useTranslations } from "use-intl";

import { BROWSER_CONTROL_TOOL_NAME } from "@stll/api-contract/browser-control";
import {
  ASK_USER_SELECTION,
  type AskUserAnswer,
  type AskUserQuestion,
  askUserSelectionOf,
} from "@stll/api-contract/chat-ask-user";
import {
  answersInOwnWords as askUserAnswersInOwnWords,
  askUserAnswersOf,
  type AskUserDraft,
  askUserDraftOf,
  askUserOptionsOf,
  initialAskUserDrafts,
  pickAllAskUserOptions,
  pickAskUserOption,
} from "@stll/api-contract/chat-ask-user-draft";
import {
  answersInOwnWords,
  canSubmitLocalRunAnswers,
  type ChatLocalRunQuestion,
  EMPTY_LOCAL_RUN_QUESTION_DRAFT,
  localRunAnswersOf,
  type LocalRunQuestionDraft,
  type LocalRunQuestionPause,
  toggleLocalRunOption,
} from "@stll/api-contract/chat-local-run-question";
import {
  localRunProposedPlan,
  localRunToolSubtitleText,
  localRunToolView,
} from "@stll/api-contract/chat-local-run-steps";
import { USE_CONNECTOR_SECRET_TOOL_NAME } from "@stll/api-contract/chat-secret";
import { chatToolLabel } from "@stll/api-contract/chat-tool-activity";
import type { ChatToolGrantScope } from "@stll/api-contract/chat-tool-grants";
import {
  getCompleteConnectorInputRows,
  getReadableInputRows,
  humanizeIdentifier,
} from "@stll/api-contract/chat-tool-input-rows";
import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import { Text } from "@stll/ui/text";

import { writeFailure, WriteFailureNotice } from "@/components/write-failure";
import type { WriteFailure } from "@/components/write-failure";
import type { AccessTokenSource } from "@/connection/session";
import { useSession } from "@/connection/session-provider";
import { compileDraftDocument } from "@/state/chat-documents";
import {
  allowedWithGrant,
  grantableApproval,
  pendingInputKey,
} from "@/state/chat-pending-input";
import type {
  ElsewhereReason,
  PendingAnswer,
  PendingApproval,
  PendingDocument,
  PendingInput,
} from "@/state/chat-pending-input";
import { storeToolGrant } from "@/state/chat-tool-grants";

/** Why the card's last answer did not continue the turn. */
export type InputNotice = "failed" | "alreadyAnswered";

/**
 * What a paused turn waits for, answered from the phone: the calls it asks
 * to run (allowed once, for the conversation, always, or denied), the
 * model's clarifying questions, the drafts it wrote, which the phone
 * compiles, or the question a coding agent on the person's computer asked.
 * A step only another place can take says which place and why. `busy`
 * holds the card while an answer is on its way.
 */
export const ChatInputCard = ({
  busy,
  notice,
  onAnswer,
  pending,
  source,
  threadId,
}: {
  busy: boolean;
  notice: InputNotice | undefined;
  onAnswer: (answer: PendingAnswer) => void;
  pending: PendingInput | null;
  source: AccessTokenSource;
  threadId: string;
}) => {
  const t = useTranslations("chat");
  if (pending === null || pending.type === "elsewhere") {
    const said = [
      pending === null ? undefined : t(ELSEWHERE_NOTES[pending.reason]),
      notice === "alreadyAnswered" ? t("alreadyAnswered") : undefined,
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
      {notice === "alreadyAnswered" ? (
        // An earlier pause was answered already; this is the one after it.
        <Text variant="caption">{t("alreadyAnswered")}</Text>
      ) : null}
      {pending.type === "steps" ? (
        <StepsCard
          busy={busy}
          // A new pause starts with nothing entered; the same one keeps it.
          key={pendingInputKey(pending)}
          onAnswer={onAnswer}
          pending={pending}
          source={source}
          threadId={threadId}
        />
      ) : (
        <QuestionCard
          busy={busy}
          key={pendingInputKey(pending)}
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

/** Where each step only another place takes is finished, and why. */
const ELSEWHERE_NOTES = {
  browser: "elsewhereBrowser",
  secret: "elsewhereSecret",
  connector: "elsewhereConnector",
  other: "elsewhereOther",
} as const satisfies Record<ElsewhereReason, string>;

type AskDrafts = Readonly<
  Record<string, Readonly<Record<number, AskUserDraft>>>
>;

const draftsOfAsk = (drafts: AskDrafts, interruptId: string) =>
  Object.hasOwn(drafts, interruptId) ? (drafts[interruptId] ?? {}) : {};

/**
 * The steps of one model turn, answered together as the server takes them:
 * each call it asks to run, its clarifying questions (option chips, several
 * on a multiple-choice question with Select all, or the person's own words),
 * and the drafts it wrote, which the phone compiles as it answers. A lone
 * approval is answered with its button; a lone draft is compiled and sent
 * as soon as the card shows it, as the web settles one; anything else goes
 * with Submit once every step has its answer.
 */
const StepsCard = ({
  busy,
  onAnswer,
  pending,
  source,
  threadId,
}: {
  busy: boolean;
  onAnswer: (answer: PendingAnswer) => void;
  pending: Extract<PendingInput, { type: "steps" }>;
  source: AccessTokenSource;
  threadId: string;
}) => {
  const t = useTranslations("chat");
  const { approvals, asks, documents } = pending;
  const [allowed, setAllowed] = useState<Readonly<Record<string, boolean>>>({});
  const [drafts, setDrafts] = useState<AskDrafts>(() =>
    Object.fromEntries(
      asks.map(({ interruptId, questions }) => [
        interruptId,
        initialAskUserDrafts(questions),
      ]),
    ),
  );
  const asked = asks.flatMap(({ interruptId, questions }) => {
    const answers = askUserAnswersOf(
      questions,
      draftsOfAsk(drafts, interruptId),
    );
    return answers === null ? [] : [[interruptId, answers] as const];
  });
  const decided = approvals.every(({ interruptId }) =>
    Object.hasOwn(allowed, interruptId),
  );
  const complete = decided && asked.length === asks.length;
  const loneApproval = approvals.length === 1 && asks.length === 0;

  const send = (decisions: Readonly<Record<string, boolean>>) => {
    onAnswer({
      type: "steps",
      allowed: decisions,
      asked: Object.fromEntries<readonly AskUserAnswer[]>(asked),
      documents: compiledDocuments(documents, t("documentFailed")),
    });
  };
  const decide = (decisions: Readonly<Record<string, boolean>>) => {
    if (loneApproval) {
      send(decisions);
      return;
    }
    setAllowed(decisions);
  };

  // A turn that only waits for its drafts asks the person nothing: they are
  // compiled and sent at once.
  const sendDrafts = useEffectEvent(() => {
    send({});
  });
  const onlyDrafts = approvals.length === 0 && asks.length === 0;
  useEffect(() => {
    if (onlyDrafts) {
      sendDrafts();
    }
  }, [onlyDrafts]);

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
            decide({ ...allowed, [approval.interruptId]: approved });
          }}
          onGranted={() => {
            // The grant lands after a request, while other approvals may
            // have been decided: it is applied to the decisions as they are
            // now, never to the ones it started from.
            const granted = (current: Readonly<Record<string, boolean>>) =>
              allowedWithGrant(
                approvals,
                { ...current, [approval.interruptId]: true },
                approval.toolName,
              );
            if (loneApproval) {
              send(granted({}));
              return;
            }
            setAllowed(granted);
          }}
          source={source}
          threadId={threadId}
        />
      ))}
      {asks.length === 0 ? null : (
        <Text variant="label">{t("questionTitle")}</Text>
      )}
      {asks.flatMap(({ interruptId, questions }) =>
        questions.map((question, index) => (
          <AskUserField
            busy={busy}
            draft={askUserDraftOf(draftsOfAsk(drafts, interruptId), index)}
            // A question is answered by its place in its ask.
            key={`${interruptId}:${String(index)}`}
            onChange={(next) => {
              setDrafts((current) => {
                const ask = draftsOfAsk(current, interruptId);
                return {
                  ...current,
                  [interruptId]: {
                    ...ask,
                    [index]: next(askUserDraftOf(ask, index)),
                  },
                };
              });
            }}
            question={question}
          />
        )),
      )}
      {documents.map(({ input, interruptId }) => (
        <Text key={interruptId} variant="caption">
          {`${t("documentPreparing")}: ${input.name}`}
        </Text>
      ))}
      {/* A lone approval is answered with its buttons; drafts alone are sent
          as the card shows, and Submit sends them again after a failure. */}
      {loneApproval ? null : (
        <Button
          className="self-start"
          disabled={busy || !complete}
          loading={busy}
          onPress={() => {
            send(allowed);
          }}
          size="sm"
        >
          {t("submitAnswers")}
        </Button>
      )}
    </View>
  );
};

/** Each draft compiled as the web compiles it, by its interrupt. */
const compiledDocuments = (
  documents: readonly PendingDocument[],
  failedMessage: string,
): Record<string, unknown> =>
  Object.fromEntries(
    documents.map(({ input, interruptId }) => [
      interruptId,
      compileDraftDocument(input, failedMessage),
    ]),
  );

/** One of the model's questions: its option chips, or the person's own words. */
const AskUserField = ({
  busy,
  draft,
  onChange,
  question,
}: {
  busy: boolean;
  draft: AskUserDraft;
  onChange: (next: (draft: AskUserDraft) => AskUserDraft) => void;
  question: AskUserQuestion;
}) => {
  const t = useTranslations("chat");
  const options = askUserOptionsOf(question);
  const ownWords = askUserAnswersInOwnWords(question, draft);
  const multiple = askUserSelectionOf(question) === ASK_USER_SELECTION.multiple;

  return (
    <View className="gap-2">
      <Text>{question.question}</Text>
      {question.reason === "" ? null : (
        <Text variant="caption">{question.reason}</Text>
      )}
      {multiple && !ownWords ? (
        <Text variant="caption">{t("questionChooseSeveral")}</Text>
      ) : null}
      {ownWords ? (
        <View className="gap-2">
          <Input
            accessibilityLabel={question.question}
            disabled={busy}
            onChangeText={(text) => {
              onChange((current) => ({ ...current, text }));
            }}
            placeholder={t("questionPlaceholder")}
            size="sm"
            value={draft.text}
          />
          {options.length > 0 ? (
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
          {options.map((option) => (
            <Button
              accessibilityRole={multiple ? "checkbox" : "radio"}
              accessibilityState={{ checked: draft.picked.includes(option) }}
              disabled={busy}
              key={option}
              onPress={() => {
                onChange((current) =>
                  pickAskUserOption(question, current, option),
                );
              }}
              selected={draft.picked.includes(option)}
              size="sm"
              variant="outline"
            >
              {option}
            </Button>
          ))}
          {multiple ? (
            <Button
              disabled={busy}
              onPress={() => {
                onChange((current) => pickAllAskUserOptions(question, current));
              }}
              size="sm"
              variant="muted"
            >
              {t("questionSelectAll")}
            </Button>
          ) : null}
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
        </View>
      )}
    </View>
  );
};

/**
 * One call to allow or deny: what it is, what it was given, and the
 * answers the web offers. A tool a stored grant may cover is also allowed
 * for the conversation or always; the grant is stored first, and the call
 * is allowed once the server has it. A browser command says where it runs.
 */
const ApprovalRow = ({
  approval,
  busy,
  decision,
  onDecide,
  onGranted,
  source,
  threadId,
}: {
  approval: PendingApproval;
  busy: boolean;
  decision: boolean | undefined;
  onDecide: (approved: boolean) => void;
  onGranted: () => void;
  source: AccessTokenSource;
  threadId: string;
}) => {
  const t = useTranslations("chat");
  const { end } = useSession();
  const [granting, setGranting] = useState<ChatToolGrantScope>();
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  const rowOptions = {
    emptyLabel: t("inputEmpty"),
    input: approval.input,
    requestLabel: t("inputRequest"),
  };
  // A step a coding agent asks about on the person's computer reads as its
  // row does: its kind, and the command, file or search it is about.
  const local = localRunToolView({
    name: approval.toolName,
    input: approval.input,
    output: undefined,
  });
  const localAbout =
    local === null
      ? null
      : (localRunProposedPlan({
          name: approval.toolName,
          input: approval.input,
        }) ??
        localRunToolSubtitleText(local.subtitle, {
          patternInPath: (values) => t("localRun.patternInPath", values),
          commandExited: (values) => t("localRun.commandExited", values),
        }));
  const title = (() => {
    if (local === null) {
      return humanizeIdentifier(approval.toolName);
    }
    return local.detailKind === null
      ? t(`tool.${chatToolLabel(approval.toolName)}`)
      : t(`localRun.title.${local.detailKind}`);
  })();
  // A credential-backed call sends exactly these arguments once approved, so
  // the phone shows every one in full, as the web does.
  const rows = (() => {
    if (local !== null) {
      return [];
    }
    return approval.toolName === USE_CONNECTOR_SECRET_TOOL_NAME
      ? getCompleteConnectorInputRows(rowOptions)
      : getReadableInputRows(rowOptions);
  })();
  const held = busy || granting !== undefined;

  const grant = async (scope: ChatToolGrantScope) => {
    setGranting(scope);
    setFailure(null);
    const stored = await storeToolGrant({
      fetch,
      scope,
      source,
      threadId,
      toolName: approval.toolName,
    });
    setGranting(undefined);
    if (Result.isOk(stored)) {
      onGranted();
      return;
    }
    if (stored.error._tag === "SignedOutError") {
      end(source);
      return;
    }
    setFailure(writeFailure(stored.error));
  };

  return (
    <View className="gap-2">
      <View className="gap-0.5">
        <Text variant="label">{t("approvalTitle")}</Text>
        <Text variant="caption">{title}</Text>
      </View>
      {localAbout === null || localAbout === "" ? null : (
        <Text selectable>{localAbout}</Text>
      )}
      {rows.map((row) => (
        <View className="gap-0.5" key={row.key}>
          <Text variant="caption">{row.label}</Text>
          <Text selectable>{row.value}</Text>
        </View>
      ))}
      {approval.toolName === BROWSER_CONTROL_TOOL_NAME ? (
        <Text variant="caption">{t("approvalBrowserNote")}</Text>
      ) : null}
      <View className="flex-row flex-wrap gap-2">
        <Button
          disabled={held}
          onPress={() => {
            onDecide(true);
          }}
          selected={decision === true}
          size="sm"
          variant={decision === undefined ? "default" : "outline"}
        >
          {t("approvalAllowOnce")}
        </Button>
        {grantableApproval(approval.toolName) ? (
          <>
            <Button
              disabled={held}
              loading={granting === "conversation"}
              onPress={() => {
                void grant("conversation");
              }}
              size="sm"
              variant="outline"
            >
              {t("approvalAllowInConversation")}
            </Button>
            <Button
              disabled={held}
              loading={granting === "always"}
              onPress={() => {
                void grant("always");
              }}
              size="sm"
              variant="outline"
            >
              {t("approvalAlwaysAllow")}
            </Button>
          </>
        ) : null}
        <Button
          disabled={held}
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
      <WriteFailureNotice failure={failure} message={t("grantFailed")} />
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

import { useState } from "react";

import { View } from "react-native";
import { useTranslations } from "use-intl";

import {
  type ChatLocalRunRequest,
  type ChatLocalRunRequestAnswer,
  type ChatLocalRunRequestAnswerOutcome,
  type LocalRunRequestUnanswered,
  unansweredLocalRunRequest,
} from "@stll/api-contract/chat-local-run-request";
import { Button } from "@stll/ui/button";
import { Text } from "@stll/ui/text";

import { QuestionCard } from "@/components/chat-input-card";

/**
 * Why steps the run asked about went on without the person's answer, said
 * neutrally: the run's output beside them stands as it is.
 */
export const LocalRunRequestNotices = ({
  reasons,
}: {
  reasons: readonly LocalRunRequestUnanswered[];
}) => {
  const t = useTranslations("chat");
  return reasons.map((reason) => (
    <Text key={reason} variant="caption">
      {t(`localRun.request.${reason}`)}
    </Text>
  ));
};

/**
 * What the run on the person's computer asks while its turn keeps running:
 * the oldest pending request of the live answer, as the web's card asks it.
 * Its answer goes to the run beside the turn; the turn's stream then closes
 * the request, which hides the card. The run may also go on without it, and
 * its end closes the request the same way, and the card then says why.
 */
export const LocalRunRequestCard = ({
  onAnswer,
  requests,
}: {
  onAnswer: (
    requestId: string,
    answer: ChatLocalRunRequestAnswer,
  ) => Promise<ChatLocalRunRequestAnswerOutcome | null>;
  requests: readonly ChatLocalRunRequest[];
}) => {
  const t = useTranslations("chat");
  // The request an answer is on its way for; the stream closes it.
  const [sent, setSent] = useState<string | null>(null);
  const request = requests.find(({ status }) => status === "pending");
  if (request === undefined) {
    const reasons = [
      ...new Set(
        requests.flatMap(
          (closed) => unansweredLocalRunRequest(closed, true) ?? [],
        ),
      ),
    ];
    return reasons.length === 0 ? null : (
      <LocalRunRequestNotices reasons={reasons} />
    );
  }
  const { requestId } = request;
  const busy = sent === requestId;
  const answer = (reply: ChatLocalRunRequestAnswer) => {
    setSent(requestId);
    void (async () => {
      const outcome = await onAnswer(requestId, reply);
      // Not sent: the person can answer again. Any other outcome closes the
      // request on the stream. A later request's answer keeps its own mark.
      if (outcome === null || outcome.type === "refused") {
        setSent((current) => (current === requestId ? null : current));
      }
    })();
  };
  const { ask } = request;
  if (ask.kind === "question") {
    return (
      <QuestionCard
        busy={busy}
        key={request.requestId}
        onAnswer={(reply) => {
          if (reply.type !== "question") {
            return;
          }
          answer(
            reply.answers === null
              ? { type: "dismiss" }
              : { type: "question", answers: reply.answers },
          );
        }}
        pause={{ interruptId: request.requestId, questions: ask.questions }}
      />
    );
  }
  return (
    <View className="gap-3" key={request.requestId}>
      <Text variant="label">{ask.message}</Text>
      <View className="flex-row flex-wrap gap-2">
        {ask.decisions.includes("approve") ? (
          <Button
            disabled={busy}
            onPress={() => {
              answer({ type: "approval", decision: "approve" });
            }}
            size="sm"
          >
            {t("approvalAllowOnce")}
          </Button>
        ) : null}
        {ask.decisions.includes("approve_for_session") ? (
          <Button
            disabled={busy}
            onPress={() => {
              answer({ type: "approval", decision: "approve_for_session" });
            }}
            size="sm"
            variant="outline"
          >
            {t("approvalAllowInConversation")}
          </Button>
        ) : null}
        {ask.decisions.includes("deny") ? (
          <Button
            disabled={busy}
            onPress={() => {
              answer({ type: "approval", decision: "deny" });
            }}
            size="sm"
            variant="outline"
          >
            {t("approvalDeny")}
          </Button>
        ) : null}
      </View>
    </View>
  );
};

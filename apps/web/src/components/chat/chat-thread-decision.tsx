import type { MouseEvent } from "react";

import { panic } from "better-result";

import { BidiText } from "@stll/ui/bidi-text";
import { DocumentIdentityBadge } from "@stll/ui/document-identity-badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "@stll/ui/tooltip";
import { useIsMobile } from "@stll/ui/use-mobile";

import {
  createCaseDecisionViewTab,
  isPlainPrimaryClick,
} from "@/components/inspector/case-decision-view";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { decisionChatKey } from "@/features/chat/legal-document-chat-key";
import type { ChatHistoryItem } from "@/features/chat/queries";
import { useFormatter } from "@/i18n/formatting-context";
import { toChatThreadId } from "@/lib/chat-thread-ref";
import { formatDecisionDate } from "@/lib/decision-date";
import { toSafeId } from "@/lib/safe-id";

const INLINE_COURT_ABBREVIATION_MAX_LENGTH = 4;

export type ChatThreadDecision = Extract<
  NonNullable<ChatHistoryItem["decision"]>,
  { type: "present" }
>["badge"];

/**
 * The decision a history row can draw and open, or null: for a chat about no
 * decision, and for one whose decision the corpus could not be read for this
 * time, which lists as an ordinary chat until it can.
 */
export const drawableChatThreadDecision = ({
  decision,
}: Pick<ChatHistoryItem, "decision">): ChatThreadDecision | null => {
  if (decision === null) {
    return null;
  }
  switch (decision.type) {
    case "present":
      return decision.badge;
    case "unavailable":
      return null;
    default:
      decision satisfies never;
      return panic(`Unhandled decision state: ${JSON.stringify(decision)}`);
  }
};

/**
 * The decision a chat is about, as a history row's context: the court's chip,
 * the case number and the decision date. The chip stands for the court the
 * way it does on a decision's inspector tab; its name stays available to
 * hover and to a screen reader, since a chip never carries the court alone.
 * A court with no chip short enough to draw is written out instead.
 */
export const ChatThreadDecisionLabel = ({
  decision,
}: {
  decision: ChatThreadDecision;
}) => {
  const format = useFormatter();
  const abbreviation = decision.courtAbbreviation?.trim();
  const drawsCourtBadge =
    abbreviation !== undefined &&
    abbreviation.length > 0 &&
    abbreviation.length <= INLINE_COURT_ABBREVIATION_MAX_LENGTH;
  const date = formatDecisionDate(decision.decisionDate, format);

  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {!drawsCourtBadge ? (
        <BidiText className="shrink-0">{decision.court}</BidiText>
      ) : (
        <Tooltip>
          <TooltipTrigger render={<span className="inline-flex shrink-0" />}>
            <DocumentIdentityBadge
              identity={{
                kind: "decision",
                courtAbbreviation: abbreviation,
                courtTier: decision.courtTier,
              }}
              // Sized to the meta line it sits in, so a decision chat's row is
              // as tall as every other row in the list.
              size="inline"
            />
            <span className="sr-only">{decision.court}</span>
          </TooltipTrigger>
          <TooltipPopup>{decision.court}</TooltipPopup>
        </Tooltip>
      )}
      <BidiText className="min-w-0 truncate">{decision.caseNumber}</BidiText>
      {date === null ? null : (
        <span className="shrink-0">
          {"· "}
          {date}
        </span>
      )}
    </span>
  );
};

/**
 * Opens a decision chat where it was held: the decision in the inspector with
 * its chat beside it, rather than the bare transcript. A chat about a decision
 * reads against that decision, and its composer keeps sending it.
 *
 * Only a plain primary click on a screen that has an inspector; every other
 * gesture (a new tab, a phone) follows the row's link to the transcript.
 * Returns whether it handled the click.
 */
export const useOpenChatThreadDecision = () => {
  const openView = useInspectorTabsStore((state) => state.openView);
  const openChat = useInspectorTabsStore((state) => state.openChat);
  const inspectorAvailable = !useIsMobile();

  return (
    event: MouseEvent<HTMLAnchorElement>,
    chat: ChatHistoryItem,
  ): boolean => {
    const decision = drawableChatThreadDecision(chat);
    if (
      decision === null ||
      !inspectorAvailable ||
      !isPlainPrimaryClick(event)
    ) {
      return false;
    }
    event.preventDefault();
    const decisionId = toSafeId<"caseLawDecision">(decision.id);
    openView(
      createCaseDecisionViewTab({
        caseNumber: decision.caseNumber,
        country: decision.country,
        court: decision.court,
        decisionId,
        language: decision.language,
        languageAlternates: decision.languageAlternates,
        slug: decision.slug,
      }),
    );
    // Last, so the chat the reader clicked is the tab in front; the decision
    // is one tab away.
    // A matter chat keeps its matter, or the tab would load it as global.
    openChat({
      activeLegalKey: decisionChatKey(decisionId),
      id: toChatThreadId(chat.id),
      label: chat.title,
      ...(chat.scope === "workspace" ? { workspaceId: chat.workspaceId } : {}),
    });
    return true;
  };
};

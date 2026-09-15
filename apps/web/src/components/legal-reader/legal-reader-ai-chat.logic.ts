/**
 * How a reader's floating chat and the docked inspector divide one
 * conversation between them.
 */

import { OVERLAY_THREAD_PRESENTATION } from "@/components/ai-suggestions/file-viewer-with-ai-config";
import type { OverlayThreadPresentation } from "@/components/ai-suggestions/file-viewer-with-ai-config";
import type {
  ChatTab,
  InspectorTab,
} from "@/components/inspector/inspector-store-types";
import type { ChatThreadId } from "@/lib/chat-thread-ref";

const isDecisionChatTab = (
  tab: InspectorTab,
  decisionId: string,
): tab is ChatTab => tab.type === "chat" && tab.activeDecisionId === decisionId;

type DecisionChatTabThreadIdArgs = {
  decisionId: string;
  tabs: readonly InspectorTab[];
};

/**
 * The thread of the chat tab already showing this decision, if one is open.
 * The most recent wins: a new chat started from an older tab is the decision's
 * current conversation, and the tab it left behind is history.
 *
 * This is how the mapping survives a reload — the inspector persists chat tabs
 * with their decision and their thread id, the reader does not persist
 * anything of its own.
 */
export const decisionChatTabThreadId = ({
  decisionId,
  tabs,
}: DecisionChatTabThreadIdArgs): ChatThreadId | undefined =>
  tabs.findLast((tab): tab is ChatTab => isDecisionChatTab(tab, decisionId))
    ?.id;

type ActiveChatTabThreadIdArgs = {
  activeId: string | null;
  tabs: readonly InspectorTab[];
};

/** The thread the docked inspector is showing right now, when it is a chat. */
export const activeChatTabThreadId = ({
  activeId,
  tabs,
}: ActiveChatTabThreadIdArgs): ChatThreadId | undefined => {
  const tab = tabs.find((candidate) => candidate.id === activeId);
  return tab?.type === "chat" ? tab.id : undefined;
};

type OverlayThreadCardVisibilityArgs = {
  /** The thread the reader's floating composer is bound to. */
  overlayThreadId: ChatThreadId;
  /** The docked inspector is showing its active tab rather than minimized. */
  tabOpen: boolean;
  /** The thread that tab shows, when the tab on screen is a chat. */
  tabThreadId: ChatThreadId | undefined;
};

/**
 * Where the conversation is read while the composer floats over the text.
 *
 * A chat tab on screen showing this very thread IS the conversation view, so
 * the floating card would only repeat it beside itself. The composer stays
 * either way, and the card returns the moment that tab is closed, minimized,
 * or replaced by another tab.
 */
export const overlayThreadCardVisibility = ({
  overlayThreadId,
  tabOpen,
  tabThreadId,
}: OverlayThreadCardVisibilityArgs): OverlayThreadPresentation =>
  tabOpen && tabThreadId === overlayThreadId
    ? OVERLAY_THREAD_PRESENTATION.tab
    : OVERLAY_THREAD_PRESENTATION.card;

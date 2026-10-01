import { useState } from "react";
import type { RefObject } from "react";

import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import { copyToClipboard } from "@stll/clipboard";
import { Button } from "@stll/ui/button";
import {
  CheckIcon,
  CopyIcon,
  MessageSquarePlusIcon,
  QuoteIcon,
} from "@stll/ui/icons";
import { stellaToast } from "@stll/ui/toast";

import { useChatEditorManager } from "@/components/chat-editor-provider";
import {
  CHAT_SELECTION_ACTION,
  chatQuoteChip,
  chatSelectionActions,
  isRectWithinBounds,
  normalizeChatSelectionText,
} from "@/components/chat/chat-selection-branch.logic";
import type { ChatBranchSource } from "@/components/chat/chat-selection-branch.logic";
import { useOpenChatInInspector } from "@/components/chat/use-request-chat-about";
import { SelectionToolbar } from "@/components/selection-toolbar";
import { useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";

/** `ChatThreadMessages` marks every message it renders with its id. */
const CHAT_MESSAGE_ATTRIBUTE = "data-chat-message-id";

const COPIED_RESET_MS = 2000;

type Selected = {
  quote: string;
  rect: DOMRect;
};

const messageElementOf = (node: Node | null, root: HTMLElement) => {
  const element =
    node instanceof Element ? node : (node?.parentElement ?? null);
  const message = element?.closest(`[${CHAT_MESSAGE_ATTRIBUTE}]`) ?? null;
  return message !== null && root.contains(message) ? message : null;
};

/** The selection's range when both of its ends sit in messages of this
 *  transcript; anything else (the composer, another pane) is not ours. */
const selectedMessageRange = (
  selection: Selection,
  root: HTMLElement,
): Range | null => {
  if (
    selection.isCollapsed ||
    selection.rangeCount === 0 ||
    messageElementOf(selection.anchorNode, root) === null ||
    messageElementOf(selection.focusNode, root) === null
  ) {
    return null;
  }
  return selection.getRangeAt(0);
};

type ChatSelectionToolbarProps = {
  /** The transcript's scroll container: selections outside it are ignored,
   *  and the bar hides once the words scroll out of it. */
  rootRef: RefObject<HTMLElement | null>;
  source: ChatBranchSource;
};

/**
 * Floats over words selected in a chat message: ask about them in a new chat
 * in the inspector (the primary action), quote them into this chat's reply,
 * or copy them. A quotation lands in the composer as a chip with the caret
 * after it; nothing is ever sent on the reader's behalf.
 */
export const ChatSelectionToolbar = ({
  rootRef,
  source,
}: ChatSelectionToolbarProps) => {
  const t = useTranslations();
  const { insertPastedTextIntoThread } = useChatEditorManager();
  const openChatInInspector = useOpenChatInInspector();
  const [doc, setDoc] = useState<Document | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [copied, setCopied] = useState(false);

  const readSelection = useLatestCallback((ownerDoc: Document) => {
    const root = rootRef.current;
    const selection = ownerDoc.getSelection();
    const range =
      root === null || selection === null
        ? null
        : selectedMessageRange(selection, root);
    const quote =
      range === null || selection === null
        ? ""
        : normalizeChatSelectionText(selection.toString());
    if (range === null || root === null || quote === "") {
      setSelected(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    if (!isRectWithinBounds(rect, root.getBoundingClientRect())) {
      setSelected(null);
      return;
    }
    // A fresh selection must not inherit the previous one's confirmation.
    if (selected?.quote !== quote) {
      setCopied(false);
    }
    setSelected({ quote, rect });
  });

  useMountEffect(() => {
    const ownerDoc = rootRef.current?.ownerDocument ?? document;
    setDoc(ownerDoc);
    let frame = 0;
    const onChange = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => readSelection(ownerDoc));
    };
    const controller = new AbortController();
    ownerDoc.addEventListener("selectionchange", onChange, {
      signal: controller.signal,
    });
    // The transcript scrolls (and streams) under a selection; the bar
    // follows the words, and hides once they leave the transcript.
    ownerDoc.addEventListener("scroll", onChange, {
      capture: true,
      passive: true,
      signal: controller.signal,
    });
    return () => {
      cancelAnimationFrame(frame);
      controller.abort();
    };
  });

  if (selected === null) {
    return null;
  }

  const quoteChip = () =>
    chatQuoteChip({
      quote: selected.quote,
      quoted: (text) => t("chat.selection.quotedText", { quote: text }),
    });

  // The words are on their way elsewhere; the highlight would only linger
  // over a bar that has nothing left to act on.
  const releaseSelection = () => {
    doc?.getSelection()?.removeAllRanges();
    setSelected(null);
  };

  const askInNewChat = () => {
    const chip = quoteChip();
    releaseSelection();
    openChatInInspector({
      contextMatterIds: source.contextMatterIds,
      quote: chip,
      workspaceId:
        source.threadRef.scope === "workspace"
          ? source.threadRef.workspaceId
          : undefined,
    });
  };

  const quoteInReply = () => {
    const chip = quoteChip();
    // Released before the insert: the composer takes focus and places its
    // caret after the quote, which clearing the selection would undo.
    releaseSelection();
    insertPastedTextIntoThread(source.threadRef, chip);
  };

  const copy = async () => {
    const result = await copyToClipboard(selected.quote);
    if (Result.isError(result)) {
      getAnalytics().captureError(result.error);
      stellaToast.add({ title: t("errors.actionFailed"), type: "error" });
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), COPIED_RESET_MS);
  };

  const actions = chatSelectionActions({
    quote: selected.quote,
    source,
  });

  return (
    <SelectionToolbar
      anchorRect={selected.rect}
      ariaLabel={t("chat.selection.toolbarLabel")}
      doc={doc}
    >
      <div className="flex items-center gap-1">
        {actions.map((action) => {
          switch (action) {
            case CHAT_SELECTION_ACTION.askInNewChat: {
              return (
                <Button
                  key={action}
                  onClick={askInNewChat}
                  onMouseDown={(event) => event.preventDefault()}
                  size="sm"
                  variant="ghost"
                >
                  <MessageSquarePlusIcon className="size-3.5" />
                  {t("chat.selection.askInNewChat")}
                </Button>
              );
            }
            case CHAT_SELECTION_ACTION.quoteInReply: {
              return (
                <Button
                  key={action}
                  onClick={quoteInReply}
                  onMouseDown={(event) => event.preventDefault()}
                  size="sm"
                  variant="ghost"
                >
                  <QuoteIcon className="size-3.5" />
                  {t("chat.selection.quoteInReply")}
                </Button>
              );
            }
            case CHAT_SELECTION_ACTION.copy: {
              return (
                <Button
                  key={action}
                  onClick={() => {
                    detached(copy(), "chat-selection-toolbar.copy");
                  }}
                  onMouseDown={(event) => event.preventDefault()}
                  size="sm"
                  variant="ghost"
                >
                  {copied ? (
                    <CheckIcon className="size-3.5" />
                  ) : (
                    <CopyIcon className="size-3.5" />
                  )}
                  {copied ? t("common.copied") : t("common.copy")}
                </Button>
              );
            }
            default: {
              action satisfies never;
              return panic(`Unhandled selection action: ${String(action)}`);
            }
          }
        })}
      </div>
    </SelectionToolbar>
  );
};

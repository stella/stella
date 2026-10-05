import { useRef, useState } from "react";
import type { RefObject } from "react";

import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import { copyToClipboard } from "@stll/clipboard";
import { Button } from "@stll/ui/button";
import { CheckIcon, CopyIcon, NewChatIcon, QuoteIcon } from "@stll/ui/icons";

import { useChatEditorManager } from "@/components/chat-editor-provider";
import {
  CHAT_SELECTION_ACTION,
  chatQuoteChip,
  chatSelectionActions,
  normalizeChatSelectionText,
} from "@/components/chat/chat-selection-branch.logic";
import type { ChatBranchSource } from "@/components/chat/chat-selection-branch.logic";
import {
  SidePanelChatAnnouncer,
  SidePanelChatNote,
} from "@/components/chat/side-panel-chat-status";
import { SIDE_PANEL_CHAT_STATUS } from "@/components/chat/side-panel-chat-status.logic";
import { useSidePanelChat } from "@/components/chat/use-request-chat-about";
import { SelectionToolbar } from "@/components/selection-toolbar";
import {
  selectionToolbarAnchor,
  selectionToolbarBounds,
} from "@/components/selection-toolbar.logic";
import type { SelectionToolbarAnchor } from "@/components/selection-toolbar.logic";
import { useMountEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";

/** `ChatThreadMessages` marks every message it renders with its id. */
const CHAT_MESSAGE_ATTRIBUTE = "data-chat-message-id";

const COPIED_RESET_MS = 2000;

/** Below `sm` a full row of localized labels outgrows the screen, so the
 *  labels become the buttons' accessible names and the glyphs stay. */
const ACTION_LABEL_CLASS = "max-sm:sr-only";

type Selected = {
  quote: string;
} & SelectionToolbarAnchor;

const sameRect = (a: DOMRect, b: DOMRect): boolean =>
  a.left === b.left &&
  a.top === b.top &&
  a.right === b.right &&
  a.bottom === b.bottom;

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
  const sidePanelChat = useSidePanelChat();
  const [doc, setDoc] = useState<Document | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [copied, setCopied] = useState(false);
  // Where the bar stood when its words went to a new chat: the confirmation
  // stays there, where the reader is looking, after the selection is gone.
  const [confirmAt, setConfirmAt] = useState<SelectionToolbarAnchor | null>(
    null,
  );
  const ignorePointerSelectionChange = useRef(false);

  const readSelection = useLatestCallback(
    (ownerDoc: Document, pointer?: { x: number; y: number }) => {
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
      const anchor = selectionToolbarAnchor({
        range,
        root,
        ...(pointer === undefined ? {} : { pointer }),
      });
      if (anchor === null) {
        setSelected(null);
        return;
      }
      // A fresh selection must not inherit the previous one's confirmation.
      if (selected?.quote !== quote) {
        setCopied(false);
      }
      // Nor may the last confirmation return once this selection goes.
      setConfirmAt(null);
      setSelected({ ...anchor, quote });
    },
  );

  useMountEffect(() => {
    const root = rootRef.current;
    if (root === null) {
      setDoc(null);
      return undefined;
    }
    const ownerDoc = root.ownerDocument;
    setDoc(ownerDoc);
    let frame = 0;
    const onChange = () => {
      if (ignorePointerSelectionChange.current) {
        ignorePointerSelectionChange.current = false;
        return;
      }
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => readSelection(ownerDoc));
    };
    const onPointerUp = (event: PointerEvent) => {
      const NodeConstructor = ownerDoc.defaultView?.Node;
      if (
        NodeConstructor === undefined ||
        !(event.target instanceof NodeConstructor) ||
        !root.contains(event.target)
      ) {
        return;
      }
      cancelAnimationFrame(frame);
      ignorePointerSelectionChange.current = true;
      readSelection(ownerDoc, { x: event.clientX, y: event.clientY });
    };
    const onKeyDown = () => {
      // A keyboard-modified range belongs to its textual end, not the last
      // pointer position that happened to create an earlier selection.
      ignorePointerSelectionChange.current = false;
    };
    const onScroll = () => {
      ignorePointerSelectionChange.current = false;
      onChange();
    };
    const updateConfirmationBounds = () => {
      const bounds = selectionToolbarBounds(root);
      if (bounds === null) {
        setConfirmAt(null);
        return;
      }
      setConfirmAt((current) => {
        if (current === null || sameRect(current.bounds, bounds)) {
          return current;
        }
        return { bounds, rect: current.rect };
      });
    };
    const onLayoutChange = () => {
      onScroll();
      updateConfirmationBounds();
    };
    const controller = new AbortController();
    ownerDoc.addEventListener("selectionchange", onChange, {
      signal: controller.signal,
    });
    ownerDoc.addEventListener("pointerup", onPointerUp, {
      capture: true,
      signal: controller.signal,
    });
    ownerDoc.addEventListener("keydown", onKeyDown, {
      capture: true,
      signal: controller.signal,
    });
    // The transcript scrolls (and streams) under a selection; the bar
    // follows the words, and hides once they leave the transcript. A
    // confirmation ignores scrolling: opening the side panel narrows and
    // scrolls the transcript itself, so only a new selection or its timeout
    // ends it, and it stays where the reader was looking.
    ownerDoc.addEventListener("scroll", onLayoutChange, {
      capture: true,
      passive: true,
      signal: controller.signal,
    });
    ownerDoc.defaultView?.addEventListener("resize", onLayoutChange, {
      signal: controller.signal,
    });
    const ResizeObserverConstructor = ownerDoc.defaultView?.ResizeObserver;
    const resizeObserver =
      ResizeObserverConstructor === undefined
        ? null
        : new ResizeObserverConstructor(onLayoutChange);
    resizeObserver?.observe(root);
    return () => {
      cancelAnimationFrame(frame);
      controller.abort();
      resizeObserver?.disconnect();
    };
  });

  // Both returns keep the live region in the same slot, so it stays mounted
  // as the bar turns into its confirmation and the change is announced.
  const announcer = <SidePanelChatAnnouncer status={sidePanelChat.status} />;

  if (selected === null) {
    const confirming =
      confirmAt !== null &&
      sidePanelChat.status !== SIDE_PANEL_CHAT_STATUS.idle;
    return (
      <>
        {confirming ? (
          <SelectionToolbar
            anchorRect={confirmAt.rect}
            boundaryRect={confirmAt.bounds}
            doc={doc}
            key="confirm"
          >
            <SidePanelChatNote
              className="min-h-7 px-2 py-1"
              status={sidePanelChat.status}
            />
          </SelectionToolbar>
        ) : null}
        {announcer}
      </>
    );
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

  // Opens at once (nothing to wait on), so it goes straight to confirming.
  const askInNewChat = () => {
    const chip = quoteChip();
    setConfirmAt({ bounds: selected.bounds, rect: selected.rect });
    releaseSelection();
    sidePanelChat.open({
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
      notifyUserError(result.error, t("errors.actionFailed"));
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
    <>
      <SelectionToolbar
        anchorRect={selected.rect}
        boundaryRect={selected.bounds}
        ariaLabel={t("chat.selection.toolbarLabel")}
        doc={doc}
        key="actions"
      >
        {/* Wraps rather than run off a narrow screen; on a phone the
            actions go icon-only and keep their labels as accessible names. */}
        <div className="flex flex-wrap items-center gap-1">
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
                    <NewChatIcon className="size-3.5" />
                    <span className={ACTION_LABEL_CLASS}>
                      {t("chat.selection.askInNewChat")}
                    </span>
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
                    <span className={ACTION_LABEL_CLASS}>
                      {t("chat.selection.quoteInReply")}
                    </span>
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
                    <span className={ACTION_LABEL_CLASS}>
                      {copied ? t("common.copied") : t("common.copy")}
                    </span>
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
      {announcer}
    </>
  );
};

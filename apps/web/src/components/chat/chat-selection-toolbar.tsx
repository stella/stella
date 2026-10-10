import { useCallback, useState } from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";

import { panic, Result } from "better-result";
import { useTranslations } from "use-intl";

import { copyToClipboard } from "@stll/clipboard";
import { Button } from "@stll/ui/button";
import {
  AiActionIcon,
  CheckIcon,
  CopyIcon,
  NewChatIcon,
  QuoteIcon,
} from "@stll/ui/icons";

import { useChatEditorManager } from "@/components/chat-editor-provider";
import {
  CHAT_SELECTION_ACTION,
  chatQuoteChip,
  chatSelectionActions,
  normalizeChatSelectionText,
} from "@/components/chat/chat-selection-branch.logic";
import type { ChatBranchSource } from "@/components/chat/chat-selection-branch.logic";
import { getAwaitedAssistantMessageId } from "@/components/chat/chat-ui-tools";
import type { ChatUIMessage } from "@/components/chat/chat-ui-tools";
import {
  SidePanelChatAnnouncer,
  SidePanelChatNote,
} from "@/components/chat/side-panel-chat-status";
import { SIDE_PANEL_CHAT_STATUS } from "@/components/chat/side-panel-chat-status.logic";
import { useSidePanelChat } from "@/components/chat/use-request-chat-about";
import { SelectionToolbar } from "@/components/selection-toolbar";
import { selectionToolbarAnchor } from "@/components/selection-toolbar.logic";
import type { SelectionToolbarAnchor } from "@/components/selection-toolbar.logic";
import type { AnswerEditAnchor } from "@/features/chat/answer-edit/answer-edit-api";
import { AnswerEditPanel } from "@/features/chat/answer-edit/answer-edit-panel";
import { mapAnswerSelection } from "@/features/chat/answer-edit/answer-edit-selection";
import { useChatSelectionEvents } from "@/features/chat/answer-edit/use-chat-selection-events";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { notifyUserError } from "@/lib/errors/user-toast";
import { CapabilityAction } from "@/lib/organization/feature-access/capability-actions";

/** `ChatThreadMessages` marks every message it renders with its id. */
const CHAT_MESSAGE_ATTRIBUTE = "data-chat-message-id";

const COPIED_RESET_MS = 2000;
const EMPTY_MESSAGES: readonly ChatUIMessage[] = [];

/** Below `sm` a full row of localized labels outgrows the screen, so the
 *  labels become the buttons' accessible names and the glyphs stay. */
const ACTION_LABEL_CLASS = "max-sm:sr-only";

type AnswerEditing = AnswerEditAnchor & SelectionToolbarAnchor;

type Selected = {
  quote: string;
  edit: ReturnType<typeof mapAnswerSelection> | { status: "unavailable" };
} & SelectionToolbarAnchor;

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
  messages?: readonly ChatUIMessage[];
  isGenerating?: boolean;
  onAnswerEdited?: ((messageId: string) => Promise<void>) | undefined;
  answerRewriteAvailability: "available" | "anonymized" | "unknown";
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
  messages = EMPTY_MESSAGES,
  isGenerating = false,
  onAnswerEdited,
  answerRewriteAvailability,
}: ChatSelectionToolbarProps) => {
  const t = useTranslations();
  const editsDisabled = answerEditIsDisabled(messages, isGenerating);
  const { insertPastedTextIntoThread } = useChatEditorManager();
  const sidePanelChat = useSidePanelChat();
  const [doc, setDoc] = useState<Document | null>(null);
  const [selected, setSelected] = useState<Selected | null>(null);
  const [editing, setEditing] = useState<AnswerEditing | null>(null);
  const [editError, setEditError] = useState(false);
  const refreshEditedAnswer = useCallback(async () => {
    await (editing === null ? undefined : onAnswerEdited?.(editing.messageId));
  }, [editing, onAnswerEdited]);
  const [copied, setCopied] = useState(false);
  // Where the bar stood when its words went to a new chat: the confirmation
  // stays there, where the reader is looking, after the selection is gone.
  const [confirmAt, setConfirmAt] = useState<SelectionToolbarAnchor | null>(
    null,
  );

  const readSelection = useLatestCallback(
    (ownerDoc: Document, pointer?: { x: number; y: number }) => {
      if (editing !== null) {
        return;
      }
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
      const messageNode = messageElementOf(range.startContainer, root);
      const message = messages.find(
        (item) => item.id === messageNode?.getAttribute(CHAT_MESSAGE_ATTRIBUTE),
      );
      let edit: Selected["edit"] = { status: "unavailable" };
      if (
        messageNode !== null &&
        message?.role === "assistant" &&
        message.revision !== undefined &&
        onAnswerEdited !== undefined &&
        answerRewriteAvailability === "available"
      ) {
        edit = mapAnswerSelection({
          message,
          baseRevision: message.revision,
          messageRoot: messageNode,
          range,
        });
      }
      setEditError(false);
      setSelected({ ...anchor, quote, edit });
    },
  );

  useChatSelectionEvents({ rootRef, readSelection, setDoc, setConfirmAt });

  // Both returns keep the live region in the same slot, so it stays mounted
  // as the bar turns into its confirmation and the change is announced.
  const announcer = <SidePanelChatAnnouncer status={sidePanelChat.status} />;

  if (editing !== null) {
    return (
      <>
        <SelectionToolbar
          anchorRect={editing.rect}
          boundaryRect={editing.bounds}
          doc={doc}
          key="edit"
        >
          <AnswerEditPanel
            key={`${editing.messageId}:${editing.baseRevision}:${editing.start}:${editing.end}`}
            anchor={editing}
            threadId={source.threadRef.threadId}
            disabled={
              editsDisabled || answerRewriteAvailability !== "available"
            }
            onCancel={() => {
              setEditing(null);
              setSelected(null);
            }}
            onAnswerEdited={refreshEditedAnswer}
          />
        </SelectionToolbar>
        {announcer}
      </>
    );
  }

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

  const copy = () =>
    copySelectedText({
      quote: selected.quote,
      setCopied,
      errorMessage: t("errors.actionFailed"),
    });

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
          {selected.edit.status !== "unavailable" &&
            answerRewriteAvailability === "available" && (
              <CapabilityAction action={{ capability: "ai" }} surface="control">
                {(capabilityProps) => (
                  <Button
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      if (selected.edit.status !== "available") {
                        setEditError(true);
                        return;
                      }
                      setEditing({
                        ...selected.edit.anchor,
                        bounds: selected.bounds,
                        rect: selected.rect,
                      });
                      doc?.getSelection()?.removeAllRanges();
                    }}
                    size="sm"
                    variant="ghost"
                    {...capabilityProps}
                    disabled={editsDisabled || capabilityProps.disabled}
                  >
                    <AiActionIcon className="size-3.5" />
                    <span className={ACTION_LABEL_CLASS}>
                      {t("chat.answerEdit.ask")}
                    </span>
                  </Button>
                )}
              </CapabilityAction>
            )}
          {editError && (
            <p className="w-full px-2 py-1" role="alert">
              {t("chat.answerEdit.invalidSelection")}
            </p>
          )}
          {actions.map((action) => {
            switch (action) {
              case CHAT_SELECTION_ACTION.askInNewChat: {
                return (
                  <CapabilityAction
                    action={{ capability: "ai" }}
                    key={action}
                    surface="control"
                  >
                    {(capabilityProps) => (
                      <Button
                        onClick={askInNewChat}
                        onMouseDown={(event) => event.preventDefault()}
                        size="sm"
                        variant="ghost"
                        {...capabilityProps}
                      >
                        <NewChatIcon className="size-3.5" />
                        <span className={ACTION_LABEL_CLASS}>
                          {t("chat.selection.askInNewChat")}
                        </span>
                      </Button>
                    )}
                  </CapabilityAction>
                );
              }
              case CHAT_SELECTION_ACTION.quoteInReply: {
                return (
                  <CapabilityAction
                    action={{ capability: "ai" }}
                    key={action}
                    surface="control"
                  >
                    {(capabilityProps) => (
                      <Button
                        onClick={quoteInReply}
                        onMouseDown={(event) => event.preventDefault()}
                        size="sm"
                        variant="ghost"
                        {...capabilityProps}
                      >
                        <QuoteIcon className="size-3.5" />
                        <span className={ACTION_LABEL_CLASS}>
                          {t("chat.selection.quoteInReply")}
                        </span>
                      </Button>
                    )}
                  </CapabilityAction>
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

type CopySelectedTextOptions = {
  quote: string;
  setCopied: Dispatch<SetStateAction<boolean>>;
  errorMessage: string;
};

async function copySelectedText({
  quote,
  setCopied,
  errorMessage,
}: CopySelectedTextOptions) {
  const result = await copyToClipboard(quote);
  if (Result.isError(result)) {
    getAnalytics().captureError(result.error);
    notifyUserError(result.error, errorMessage);
    return;
  }
  setCopied(true);
  setTimeout(() => setCopied(false), COPIED_RESET_MS);
}

const answerEditIsDisabled = (
  messages: readonly ChatUIMessage[],
  isGenerating: boolean,
) => isGenerating || getAwaitedAssistantMessageId(messages) !== null;

/**
 * FileChatOverlay
 *
 * The floating chat that sits on top of a file viewer (DOCX, PDF).
 * Same backend, same composer, same persistence as the inspector
 * Chat tab — just a different shell:
 *   - bar is absolutely positioned at the bottom of the viewer
 *   - thread is a collapsible glass card that opens above the bar
 *
 * Suggestion-accept UI from the previous file-overlay flow is not
 * here yet; it will come back as a tool-call surface (the model
 * proposes edits via a `propose-suggestion` tool, the frontend
 * extracts and renders accept/reject cards). That work is Phase E.
 */

import {
  Suspense,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { RefObject } from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import { LoaderCircleIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import { v7 as uuidv7 } from "uuid";

import type {
  DocxEditorRef,
  FolioAIEditOperation,
  FolioAIEditSeverity,
  FolioAIEditSnapshot,
} from "@stll/folio";
import { cn } from "@stll/ui/lib/utils";

import { PromptBar } from "@/components/ai-suggestions/host";
import {
  REVIEW_UNSPECIFIED_AREA,
  useReviewStore,
} from "@/components/ai-suggestions/review-store";
import type {
  ReviewSuggestion,
  ReviewSuggestionPreview,
} from "@/components/ai-suggestions/review-store";
import { useChatEditor } from "@/components/chat-editor-provider";
import { ChatThreadMessages } from "@/components/chat/chat-thread-messages";
import type {
  ActiveDocxEditApprovalPart,
  ApprovalToolName,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import { useAIKeyGate } from "@/components/require-ai-key";
import { ChatAnonymizationLayer } from "@/lib/anonymize/use-chat-anonymization-layer";
import type { ChatThreadId, ChatThreadRef } from "@/lib/chat-thread-ref";
import { createChatThreadId } from "@/lib/chat-thread-ref";
import { useDevStore } from "@/lib/dev-store";
import { useChatSession } from "@/routes/_protected.chat/-hooks/use-chat-session";
import { useChatUserContext } from "@/routes/_protected.chat/-hooks/use-chat-user-context";
import type {
  ApplyActiveDocxEditsInput,
  ApplyActiveDocxEditsOutput,
} from "@/routes/_protected.chat/-queries";
import { chatThreadOptions } from "@/routes/_protected.chat/-queries";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";

type ActiveFile = {
  docxEditSnapshot?:
    | (Pick<FolioAIEditSnapshot, "blocks"> & {
        canApplyEdits?: boolean | undefined;
      })
    | undefined;
  entityId: string;
  editable?: boolean | undefined;
  fileName: string;
  supportsDocxEdits?: boolean | undefined;
};

type ActiveExternal = {
  connectorSlug?: string | undefined;
  provider?: string | undefined;
  snippet?: string | undefined;
  sourceToolName?: string | undefined;
  text?: string | undefined;
  title: string;
  url: string;
};

type ToolInputOperation = ApplyActiveDocxEditsInput["operations"][number];

const summarizeOperation = (operation: ToolInputOperation): string => {
  switch (operation.type) {
    case "replaceInBlock":
      return `Replace “${operation.find}” with “${operation.replace}”`;
    case "replaceBlock":
      return `Replace block ${operation.blockId}`;
    case "insertAfterBlock":
      return `Insert after ${operation.blockId}: ${operation.text}`;
    case "insertBeforeBlock":
      return `Insert before ${operation.blockId}: ${operation.text}`;
    case "deleteBlock":
      return `Delete block ${operation.blockId}`;
    case "commentOnBlock":
      return `Comment on ${operation.blockId}`;
    default:
      operation satisfies never;
      return "";
  }
};

type PreparedOperation = {
  folio: FolioAIEditOperation;
  input: ToolInputOperation;
  id: string;
};

const prepareOperations = (
  operations: ApplyActiveDocxEditsInput["operations"],
): PreparedOperation[] => {
  const prepared: PreparedOperation[] = [];

  for (const [index, operation] of operations.entries()) {
    const id = `ai-docx-${String(index + 1)}-${uuidv7()}`;
    let folio: FolioAIEditOperation;
    switch (operation.type) {
      case "replaceInBlock": {
        const next: FolioAIEditOperation = {
          blockId: operation.blockId,
          find: operation.find,
          id,
          replace: operation.replace,
          type: operation.type,
        };
        if (operation.comment) {
          next.comment = { text: operation.comment.text };
        }
        folio = next;
        break;
      }
      case "insertAfterBlock":
      case "insertBeforeBlock": {
        const next: FolioAIEditOperation = {
          blockId: operation.blockId,
          id,
          text: operation.text,
          type: operation.type,
        };
        if (operation.inheritFormatting !== undefined) {
          next.inheritFormatting = operation.inheritFormatting;
        }
        if (operation.comment) {
          next.comment = { text: operation.comment.text };
        }
        folio = next;
        break;
      }
      case "replaceBlock": {
        const next: FolioAIEditOperation = {
          blockId: operation.blockId,
          id,
          text: operation.text,
          type: operation.type,
        };
        if (operation.preserveFormatting !== undefined) {
          next.preserveFormatting = operation.preserveFormatting;
        }
        if (operation.comment) {
          next.comment = { text: operation.comment.text };
        }
        folio = next;
        break;
      }
      case "deleteBlock": {
        const next: FolioAIEditOperation = {
          blockId: operation.blockId,
          id,
          type: operation.type,
        };
        if (operation.comment) {
          next.comment = { text: operation.comment.text };
        }
        folio = next;
        break;
      }
      case "commentOnBlock": {
        const next: FolioAIEditOperation = {
          blockId: operation.blockId,
          comment: { text: operation.comment.text },
          id,
          type: operation.type,
        };
        if (operation.quote !== undefined) {
          next.quote = operation.quote;
        }
        folio = next;
        break;
      }
      default: {
        operation satisfies never;
        continue;
      }
    }
    prepared.push({ folio, input: operation, id });
  }

  return prepared;
};

const inputOperationSeverity = (
  operation: ToolInputOperation,
): FolioAIEditSeverity | "unspecified" =>
  "severity" in operation && operation.severity !== undefined
    ? operation.severity
    : "unspecified";

const inputOperationArea = (operation: ToolInputOperation): string =>
  "area" in operation && operation.area !== undefined
    ? operation.area
    : REVIEW_UNSPECIFIED_AREA;

type SnapshotBlock = {
  id: string;
  text: string;
  displayLabel?: string | undefined;
  previewRuns?: FolioAIEditSnapshot["blocks"][number]["previewRuns"];
};

type QueueReviewSuggestionsOptions = {
  entityId: string;
  prepared: readonly PreparedOperation[];
  /**
   * Editable blocks the AI saw at proposal time. We use them to
   * build the panel's redline preview so the reviewer can read each
   * suggestion in its surrounding context without leaving the
   * panel. Pass the same array we sent the model.
   */
  snapshotBlocks: readonly SnapshotBlock[];
  /**
   * Full editor snapshot the AI generated these ops against. Stored
   * on each suggestion so Accept resolves block ids against the
   * snapshot the AI saw — recomputing from the live editor on
   * every Accept would shift block ids after earlier accepts mutate
   * structure (insertAfterBlock appends a paragraph and renumbers
   * everything below it).
   */
  snapshot: FolioAIEditSnapshot | null;
};

const PREVIEW_CONTEXT_CHARS = 60;
const PREVIEW_ANCHOR_CHARS = 80;

/**
 * Build a redline preview for one operation against the snapshot
 * the AI saw. Returns `null` when the operation references a block
 * we don't have (rare, but defensive — e.g. the snapshot expired
 * mid-stream and the AI got an outdated copy).
 */
const buildPreview = (
  operation: ToolInputOperation,
  blocksById: Map<string, SnapshotBlock>,
): ReviewSuggestionPreview | null => {
  const block = blocksById.get(operation.blockId);
  const blockText = block?.text ?? "";
  switch (operation.type) {
    case "replaceInBlock": {
      const idx = blockText.indexOf(operation.find);
      if (idx === -1) {
        return {
          type: "replaceInBlock",
          contextBefore: blockText.slice(0, PREVIEW_CONTEXT_CHARS),
          before: operation.find,
          after: operation.replace,
          contextAfter: "",
          ...(block?.previewRuns !== undefined && {
            sourceRuns: block.previewRuns,
          }),
        };
      }
      const contextStart = Math.max(0, idx - PREVIEW_CONTEXT_CHARS);
      const matchEnd = idx + operation.find.length;
      const contextEnd = Math.min(
        blockText.length,
        matchEnd + PREVIEW_CONTEXT_CHARS,
      );
      return {
        type: "replaceInBlock",
        contextBefore: blockText.slice(contextStart, idx),
        before: operation.find,
        after: operation.replace,
        contextAfter: blockText.slice(matchEnd, contextEnd),
        ...(block?.previewRuns !== undefined && {
          sourceRuns: block.previewRuns,
          contextStart,
          matchStart: idx,
          matchEnd,
          contextEnd,
        }),
      };
    }
    case "replaceBlock":
      return {
        type: "replaceBlock",
        before: blockText,
        after: operation.text,
        ...(block?.previewRuns !== undefined && {
          sourceRuns: block.previewRuns,
        }),
      };
    case "deleteBlock":
      return {
        type: "deleteBlock",
        before: blockText,
        ...(block?.previewRuns !== undefined && {
          sourceRuns: block.previewRuns,
        }),
      };
    case "insertBeforeBlock":
    case "insertAfterBlock":
      return {
        type: operation.type,
        anchor: blockText.slice(0, PREVIEW_ANCHOR_CHARS),
        after: operation.text,
        ...(block?.previewRuns !== undefined && {
          anchorRuns: block.previewRuns,
          anchorEnd: Math.min(blockText.length, PREVIEW_ANCHOR_CHARS),
        }),
      };
    case "commentOnBlock":
      return {
        type: "commentOnBlock",
        anchor: operation.quote ?? blockText.slice(0, PREVIEW_ANCHOR_CHARS),
        ...(operation.quote === undefined &&
          block?.previewRuns !== undefined && {
            anchorRuns: block.previewRuns,
            anchorEnd: Math.min(blockText.length, PREVIEW_ANCHOR_CHARS),
          }),
      };
    default:
      operation satisfies never;
      return null;
  }
};

/**
 * Register newly proposed review-mode operations in the local
 * review store as `pending`. They are NOT applied to the document;
 * the panel's Accept handler triggers the per-op apply (and unlock
 * prompt) when the user explicitly chooses to apply each one.
 */
const queueReviewSuggestions = ({
  entityId,
  prepared,
  snapshotBlocks,
  snapshot,
}: QueueReviewSuggestionsOptions) => {
  const blocksById = new Map(snapshotBlocks.map((b) => [b.id, b]));
  const labelsById = new Map<string, string>();
  for (const b of snapshotBlocks) {
    if (b.displayLabel !== undefined && b.displayLabel.length > 0) {
      labelsById.set(b.id, b.displayLabel);
    }
  }
  const items: ReviewSuggestion[] = prepared.flatMap(({ id, input, folio }) => {
    // Drop true no-ops before they ever reach the panel: the model
    // occasionally emits `find === replace` (or replaceBlock text
    // identical to the source) as a side effect of running through
    // every block. Showing them as "X → X" cards is noise.
    if (
      (input.type === "replaceInBlock" && input.find === input.replace) ||
      (input.type === "replaceBlock" &&
        input.text === (blocksById.get(input.blockId)?.text ?? ""))
    ) {
      return [];
    }
    const preview = buildPreview(input, blocksById);
    if (!preview) {
      return [];
    }
    const base: ReviewSuggestion = {
      id,
      blockId: input.blockId,
      type: input.type,
      summary: summarizeOperation(input),
      preview,
      severity: inputOperationSeverity(input),
      area: inputOperationArea(input),
      status: "pending",
      applyMode: null,
      revisionIds: null,
      pendingOperation: folio,
      snapshot,
    };
    const label = labelsById.get(input.blockId);
    if (label !== undefined) {
      base.blockLabel = label;
    }
    if (input.comment) {
      base.comment = input.comment.text;
    }
    return [base];
  });

  useReviewStore.getState().appendSuggestions(entityId, items);

  // Auto-switch the inspector's tab for this entity to the
  // Suggestions facet with a teaching pulse, so the user
  // immediately sees where the proposals landed. Locating the tab
  // by entityId rather than by tab id keeps the chat overlay
  // ignorant of inspector internals.
  const inspectorState = useInspectorStore.getState();
  const tab = inspectorState.tabs.find(
    (candidate) => candidate.type === "pdf" && candidate.entityId === entityId,
  );
  if (tab) {
    inspectorState.setFileFacet(tab.id, "suggestions", { pulse: true });
  }
};

const isApplyActiveDocxEditsInput = (
  input: unknown,
): input is ApplyActiveDocxEditsInput =>
  typeof input === "object" &&
  input !== null &&
  "operations" in input &&
  Array.isArray(input.operations);

const getActiveDocxEditApprovalPart = (
  messages: PersistedChatMessage[],
  approvalId: string,
):
  | (ActiveDocxEditApprovalPart & { input: ApplyActiveDocxEditsInput })
  | null => {
  for (
    let messageIndex = messages.length - 1;
    messageIndex >= 0;
    messageIndex -= 1
  ) {
    const message = messages.at(messageIndex);
    if (!message || message.role !== "assistant") {
      continue;
    }

    for (const part of message.parts) {
      if (part.type !== "tool-apply-active-docx-edits") {
        continue;
      }

      if (
        (part.state === "approval-requested" ||
          part.state === "approval-responded" ||
          part.state === "output-denied") &&
        part.approval.id === approvalId &&
        isApplyActiveDocxEditsInput(part.input)
      ) {
        return part;
      }
    }
  }

  return null;
};

// No tools are auto-blocked when an active file is present. The
// prompt already steers the model away from create-document for
// edit requests on the active file (in favour of
// apply-active-docx-edits); blocking it outright robbed users of
// the legitimate "create a new document from this chat" flow.
const ACTIVE_FILE_BLOCKED_APPROVAL_TOOLS = new Set<ApprovalToolName>();

type FileChatOverlayProps = {
  /** Workspace this viewer belongs to. Scopes the thread + mention sources. */
  workspaceId?: string | undefined;
  /**
   * Stable identifier for this file's chat thread. Use the file's
   * entity id (or any per-file unique string) so drafts + history
   * persist across mounts and stay isolated from other files'
   * chats.
   */
  chatThreadId: ChatThreadId;
  /**
   * Surfaced to the model via the chat transport so prompts can
   * reference "the file you're looking at" and tools can resolve
   * its entity. Optional — when omitted the model still works
   * fine but loses the file-context hint.
   */
  activeFile?: ActiveFile | undefined;
  activeExternal?: ActiveExternal | undefined;
  docxEditorRef?: RefObject<DocxEditorRef | null> | undefined;
  docxEditable?: boolean | undefined;
  requestDocxEditMode?: (() => boolean | Promise<boolean>) | undefined;
};

export const FileChatOverlay = ({
  workspaceId,
  chatThreadId,
  activeFile,
  activeExternal,
  docxEditable,
  docxEditorRef,
  requestDocxEditMode,
}: FileChatOverlayProps) => {
  const [currentChatThreadId, setCurrentChatThreadId] = useState(chatThreadId);

  useEffect(() => {
    setCurrentChatThreadId(chatThreadId);
  }, [chatThreadId]);

  return (
    // Suspense boundary keeps the chat-thread fetch local to the
    // overlay — without it, a cold cache propagates the suspension
    // up to the file route and shows the route's pending screen.
    <Suspense
      fallback={
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 bottom-8 flex justify-center"
        >
          <LoaderCircleIcon className="text-muted-foreground size-4 animate-spin" />
        </div>
      }
    >
      <FileChatOverlayInner
        activeFile={activeFile}
        activeExternal={activeExternal}
        chatThreadId={currentChatThreadId}
        docxEditable={docxEditable}
        docxEditorRef={docxEditorRef}
        onNewThread={() => {
          // The previous thread's queued/accepted/rejected
          // suggestions belong to that thread's history. Carrying
          // them into a fresh thread invites the user to act on
          // proposals they no longer have context for; reset the
          // session whenever they explicitly start a new chat.
          if (activeFile) {
            useReviewStore.getState().resetSession(activeFile.entityId);
          }
          setCurrentChatThreadId(createChatThreadId());
        }}
        requestDocxEditMode={requestDocxEditMode}
        workspaceId={workspaceId}
      />
    </Suspense>
  );
};

type FileChatOverlayInnerProps = FileChatOverlayProps & {
  onNewThread: () => void;
};

const FileChatOverlayInner = ({
  workspaceId,
  chatThreadId,
  activeFile,
  activeExternal,
  docxEditable,
  docxEditorRef,
  onNewThread,
}: FileChatOverlayInnerProps) => {
  const t = useTranslations();
  const userContext = useChatUserContext();
  const getUserContext = useEffectEvent(() => userContext);
  const lastSentDocxEditSnapshotRef = useRef<FolioAIEditSnapshot | null>(null);
  const hasDocxEditSurface =
    activeFile !== undefined && docxEditorRef !== undefined;
  // Folio's PM view exists almost immediately after DocxBrowserEditor
  // mounts but there is a sub-100ms window where the ref is set but
  // `createAIEditSnapshot()` still returns null. Sending a message in
  // that window means the model sees no editable blocks and replies
  // with "editor is loading" instead of doing real work. Poll until
  // the first non-null snapshot lands, then stop — once ready stays
  // ready for the lifetime of the editor.
  const [editorReady, setEditorReady] = useState(false);
  useEffect(() => {
    if (editorReady || !hasDocxEditSurface) {
      return undefined;
    }
    const probe = () => {
      if (docxEditorRef.current?.createAIEditSnapshot()) {
        setEditorReady(true);
        return true;
      }
      return false;
    };
    if (probe()) {
      return undefined;
    }
    const id = window.setInterval(() => {
      if (probe()) {
        window.clearInterval(id);
      }
    }, 80);
    return () => {
      window.clearInterval(id);
    };
  }, [editorReady, hasDocxEditSurface, docxEditorRef]);
  // Reset readiness when the active file changes — the new doc has
  // its own mount cycle.
  useEffect(() => {
    setEditorReady(false);
  }, [activeFile?.entityId]);

  // Subscribe to the inspector chip's pulse channel so the bar
  // glows when the user clicks the AI-suggestions facet.
  const attentionPulseSeq = useReviewStore((state) =>
    activeFile ? state.chatInputPulse[activeFile.entityId] : undefined,
  );
  const getActiveFile = useEffectEvent(() => {
    if (!activeFile) {
      lastSentDocxEditSnapshotRef.current = null;
      return undefined;
    }

    const snapshot = docxEditorRef?.current?.createAIEditSnapshot() ?? null;
    lastSentDocxEditSnapshotRef.current = snapshot;

    if (!hasDocxEditSurface) {
      return activeFile;
    }

    if (!snapshot) {
      return { ...activeFile, supportsDocxEdits: true };
    }

    return {
      ...activeFile,
      docxEditSnapshot: {
        blocks: snapshot.blocks,
        canApplyEdits: Boolean(docxEditable),
      },
      supportsDocxEdits: true,
    };
  });
  const getActiveExternal = useEffectEvent(() => activeExternal);
  const handleActiveDocxEditToolCall = useEffectEvent(
    (input: ApplyActiveDocxEditsInput): ApplyActiveDocxEditsOutput => {
      // All edit batches — single direct edits and structured
      // reviews alike — are queued for the user. The editor is not
      // touched here; the user reviews each suggestion in the
      // panel and the unlock prompt only fires when the user
      // actually clicks Accept.
      if (!activeFile) {
        return {
          applied: [],
          queued: [],
          skipped: input.operations.map((operation, index) => ({
            id: `ai-docx-${String(index + 1)}-${operation.blockId}`,
            reason: "documentNotEditable",
          })),
        };
      }

      const prepared = prepareOperations(input.operations);
      // The most recent snapshot we sent the AI is the one its
      // operations target, so the reviewer's redline preview reads
      // against that text AND each pending suggestion carries that
      // same snapshot for Accept's resolver. Recomputing on each
      // Accept would shift block ids after earlier accepts mutate
      // structure (insertAfterBlock appends a paragraph and
      // renumbers everything below it). Falls back to null /
      // empty list when the editor never produced a snapshot —
      // preview + apply both handle that defensively.
      const lastSnapshot = lastSentDocxEditSnapshotRef.current;
      queueReviewSuggestions({
        entityId: activeFile.entityId,
        prepared,
        snapshotBlocks: lastSnapshot?.blocks ?? [],
        snapshot: lastSnapshot,
      });
      return {
        applied: [],
        queued: prepared.map(({ id }) => ({ id })),
        skipped: [],
      };
    },
  );
  const showToolCallDetails = useDevStore((s) => s.showToolCallDetails);
  const blockedApprovalTools = activeFile
    ? ACTIVE_FILE_BLOCKED_APPROVAL_TOOLS
    : undefined;

  const threadRef = useMemo<ChatThreadRef>(
    () =>
      workspaceId === undefined
        ? {
            scope: "global",
            threadId: chatThreadId,
          }
        : {
            scope: "workspace",
            threadId: chatThreadId,
            workspaceId,
          },
    [chatThreadId, workspaceId],
  );

  const { data } = useSuspenseQuery(
    chatThreadOptions({
      key: threadRef,
      context: {
        allowMissingThread: true,
        getUserContext,
        ...(activeExternal
          ? { getActiveExternal: () => getActiveExternal() }
          : {}),
        ...(activeFile ? { getActiveFile: () => getActiveFile() } : {}),
        ...(hasDocxEditSurface
          ? {
              handleActiveDocxEditToolCall: (
                input: ApplyActiveDocxEditsInput,
              ) => handleActiveDocxEditToolCall(input),
            }
          : {}),
      },
    }),
  );
  const { chat } = data;

  const {
    error,
    messages,
    resendLatestMessage,
    sendMessage,
    stop,
    isGenerating,
    alwaysApprovedTools,
    conversationApprovedTools,
    handleApprove,
    handleAllowInConversation,
    handleDeny,
    handleAskUserSubmit,
    handleAlwaysAllow,
    handleCreateDocumentResolve,
    handleOpenCreatedDocument,
    createDocumentMatters,
    isLoadingCreateDocumentMatters,
    addToolOutput,
    streamdownComponents,
    approvalPendingMessageId,
  } = useChatSession({ chat, conversationId: threadRef.threadId, workspaceId });
  const { ensureAIAvailable, openIfAIUnavailable } = useAIKeyGate();

  useEffect(() => {
    openIfAIUnavailable();
  }, [openIfAIUnavailable]);

  const filePlaceholder =
    activeFile === undefined
      ? activeExternal
        ? t("chat.externalSourcePlaceholder", {
            title: activeExternal.title,
          })
        : undefined
      : t(
          activeFile.editable
            ? "chat.editableFilePlaceholder"
            : "chat.filePlaceholder",
          { fileName: activeFile.fileName },
        );
  const filePlaceholderAction =
    activeFile === undefined
      ? activeExternal
        ? t("chat.externalSourcePlaceholderAction")
        : undefined
      : t(
          activeFile.editable
            ? "chat.editableFilePlaceholderAction"
            : "chat.filePlaceholderAction",
        );

  const editorController = useChatEditor({
    placeholder: filePlaceholder,
    threadRef,
  });
  const canSubmitWithCurrentDocxSnapshot = useEffectEvent(() => {
    if (!hasDocxEditSurface) {
      return true;
    }

    const snapshot = docxEditorRef.current?.createAIEditSnapshot() ?? null;
    if (snapshot) {
      lastSentDocxEditSnapshotRef.current = snapshot;
      return true;
    }

    lastSentDocxEditSnapshotRef.current = null;
    setEditorReady(false);
    return false;
  });

  const handleApproveWithDocxUnlock = async (
    approvalId: string,
    toolName: ApprovalToolName,
  ) => {
    if (toolName === "apply-active-docx-edits") {
      const part = getActiveDocxEditApprovalPart(messages, approvalId);
      if (!part) {
        handleApprove(approvalId, toolName);
        return;
      }

      // DOCX edits no longer apply at approval time. We approve
      // the tool call (so the LLM proceeds), queue the operations
      // into the review panel via the tool call handler, and
      // surface the queued ids back to the LLM. The actual apply
      // (including the unlock prompt) happens when the user clicks
      // Accept on a suggestion in the panel.
      handleApprove(approvalId, toolName);
      const output = handleActiveDocxEditToolCall(part.input);
      await addToolOutput({
        output,
        tool: "apply-active-docx-edits",
        toolCallId: part.toolCallId,
      });
      return;
    }

    handleApprove(approvalId, toolName);
  };

  const [panelOpen, setPanelOpen] = useState(false);
  const threadScrollRef = useRef<HTMLDivElement>(null);
  const hasMessages = messages.length > 0;
  const hasThreadContent = hasMessages || error !== undefined;
  const lastMessageId = messages.at(-1)?.id ?? null;
  // Auto-open the thread panel as soon as the first message
  // lands so users see streaming without having to click the
  // chevron themselves.
  useEffect(() => {
    if (hasThreadContent) {
      setPanelOpen(true);
    }
  }, [hasThreadContent]);
  useLayoutEffect(() => {
    const scrollElement = threadScrollRef.current;
    if (!scrollElement) {
      return;
    }

    scrollElement.scrollTo({
      behavior: "instant",
      top: scrollElement.scrollHeight,
    });
  }, [isGenerating, lastMessageId]);

  return (
    <>
      {panelOpen && hasThreadContent && (
        <div
          aria-label="AI thread"
          className={cn(
            // Sizing rules: grows with content but caps at ~45dvh
            // / 380px so the panel doesn't dominate the file
            // viewer. No min-height — short threads stay short.
            "absolute start-1/2 bottom-[88px] z-40 flex max-h-[min(45dvh,380px)] min-h-0 w-[min(560px,calc(100%-2rem))] -translate-x-1/2 flex-col overflow-hidden rounded-2xl border",
            "bg-popover/90 border-border text-popover-foreground",
            "[backdrop-filter:blur(18px)_saturate(160%)] [-webkit-backdrop-filter:blur(18px)_saturate(160%)]",
            "before:bg-foreground/[0.06] before:pointer-events-none before:absolute before:inset-x-0 before:top-0 before:h-px",
            "hover:bg-popover focus-within:bg-popover",
            "transition-[background-color,border-color] duration-200 ease-out",
            "shadow-[0_1px_2px_rgb(0_0_0/0.06),0_20px_64px_rgb(0_0_0/0.18)]",
            "animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-1",
          )}
          role="dialog"
        >
          {/* Plain scroll container — bypasses the legacy
              Conversation's `size-full` chain, which only resolves
              correctly when the parent has an explicit height
              (this overlay uses `max-h` only, so flex-1 children
              don't get a definite size to base `size-full` on). */}
          <div
            ref={threadScrollRef}
            className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3"
            style={{ scrollbarGutter: "stable" }}
          >
            <ChatThreadMessages
              alwaysApprovedTools={alwaysApprovedTools}
              approvalPendingMessageId={approvalPendingMessageId}
              blockedApprovalTools={blockedApprovalTools}
              conversationApprovedTools={conversationApprovedTools}
              error={error}
              handleAllowInConversation={handleAllowInConversation}
              handleAlwaysAllow={handleAlwaysAllow}
              handleApprove={handleApproveWithDocxUnlock}
              handleDeny={handleDeny}
              isGenerating={isGenerating}
              messages={messages}
              onAskUserSubmit={handleAskUserSubmit}
              onCreateDocumentResolve={handleCreateDocumentResolve}
              onOpenCreatedDocument={handleOpenCreatedDocument}
              createDocumentMatters={createDocumentMatters}
              isLoadingCreateDocumentMatters={isLoadingCreateDocumentMatters}
              onResend={resendLatestMessage}
              showThinkingIndicator
              showToolCallDetails={showToolCallDetails}
              streamdownComponents={streamdownComponents}
              workspaceId={workspaceId}
            />
          </div>
        </div>
      )}

      <ChatAnonymizationLayer
        editor={editorController.editor}
        enabled={false}
        workspaceId={workspaceId ?? threadRef.threadId}
      />
      <PromptBar
        attentionPulseSeq={attentionPulseSeq}
        canSubmitNow={canSubmitWithCurrentDocxSnapshot}
        editorController={editorController}
        emptyPlaceholder={
          (activeFile || activeExternal) && filePlaceholderAction ? (
            <span className="text-foreground-ghost flex min-w-0 items-center gap-1.5 text-[13px] leading-5">
              <span className="shrink-0">{filePlaceholderAction}</span>
              <span className="text-foreground-label max-w-64 truncate">
                {activeFile?.fileName ?? activeExternal?.title}
              </span>
            </span>
          ) : undefined
        }
        layout="floating"
        newThreadLabel={t("chat.newChat")}
        onNewThread={() => {
          setPanelOpen(false);
          onNewThread();
        }}
        onStop={() => {
          void stop();
        }}
        onSubmit={({ prompt }) => {
          void ensureAIAvailable().then((available) => {
            if (!available) {
              return;
            }
            // Always pop the thread open on send, even if the user
            // minimised it earlier — they're sending a new prompt
            // and want to see the response stream in.
            setPanelOpen(true);
            void sendMessage({ text: prompt });
          });
        }}
        onTogglePanel={() => setPanelOpen((v) => !v)}
        panelOpen={panelOpen}
        pendingCount={0}
        sendDisabledReason={
          activeFile && docxEditorRef && !editorReady
            ? "editor-loading"
            : undefined
        }
        showThreadToggle={hasThreadContent}
        status={isGenerating ? "generating" : "idle"}
      />
    </>
  );
};

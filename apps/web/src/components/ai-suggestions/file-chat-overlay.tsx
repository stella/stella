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
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Dispatch, RefObject, SetStateAction } from "react";

import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { panic, Result } from "better-result";
import { LoaderCircleIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import { v7 as uuidv7 } from "uuid";

import {
  DOCX_SUGGEST_CHANGES_OPTIONS_BY_SURFACE,
  DOCX_SUGGESTION_SURFACE,
} from "@stll/api-contract/chat-docx-suggestions";
import {
  createEditorRefBridge,
  executeFolioToolCall,
  FOLIO_AGENT_TOOL_NAMES,
} from "@stll/folio-agents";
import type {
  FolioAgentBridge,
  FolioAgentToolName,
  FolioAgentToolOptions,
} from "@stll/folio-agents";
import type {
  FolioAgentToolInputByName,
  FolioToolCallResultFor,
} from "@stll/folio-agents/tool-contract";
import {
  getFolioDocumentOperationIssues,
  getFolioDocumentOperationReceipts,
} from "@stll/folio-core";
import type {
  FolioDocumentOperationBatch,
  FolioDocumentOperationResult,
} from "@stll/folio-core";
import type {
  DocxEditorRef,
  FolioAIEditOperation,
  FolioAIEditSeverity,
  FolioAIEditSnapshot,
} from "@stll/folio-react";
import { BidiText } from "@stll/ui/bidi-text";
import { COMPOSER_TEXT_CLASS } from "@stll/ui/composer";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import { resolveDocxSuggestionRequest } from "@/components/ai-suggestions/docx-suggestion-persistence";
import { resolveFileReviewSessionId } from "@/components/ai-suggestions/file-review-session";
import {
  ChatThreadCard,
  FLOATING_THREAD_CARD_OFFSET_WITH_REVIEW_CLASS,
  PromptBar,
} from "@/components/ai-suggestions/host";
import { isNoopReviewOperation } from "@/components/ai-suggestions/review-operation-utils";
import {
  REVIEW_SUGGESTION_ORIGIN,
  REVIEW_UNSPECIFIED_AREA,
  useReviewStore,
} from "@/components/ai-suggestions/review-store";
import type { ReviewSuggestion } from "@/components/ai-suggestions/review-store";
import {
  buildPreview,
  folioOperationBlockId,
  folioOperationComment,
  summarizeOperation,
} from "@/components/ai-suggestions/review-suggestion-builder";
import type { SnapshotBlock } from "@/components/ai-suggestions/review-suggestion-builder";
import { withBlockTextHashes } from "@/components/ai-suggestions/snapshot-blocks";
import {
  ChatSubmitPreservedError,
  useChatEditor,
} from "@/components/chat-editor-provider";
import type { ChatDraftAttachment } from "@/components/chat-editor-provider";
import { ChatApprovalContext } from "@/components/chat/chat-approval-context";
import { ChatComposerDock } from "@/components/chat/chat-composer-dock";
import { ComposerEditModeControl } from "@/components/chat/chat-edit-mode-selector";
import { ChatMatterPicker } from "@/components/chat/chat-matter-picker";
import { ChatMattersContext } from "@/components/chat/chat-matters-context";
import { ChatThreadMessages } from "@/components/chat/chat-thread-messages";
import {
  isApprovalPart,
  selectUnresolvedFolioAgentDocToolCallParts,
  SUGGEST_CHANGES_TOOL_NAME,
} from "@/components/chat/chat-ui-tools";
import type {
  ApprovalToolName,
  ApprovalToolPart,
  PersistedChatMessage,
  RegisteredFolioAgentToolCallPart,
  UnresolvedFolioAgentDocToolCallPart,
} from "@/components/chat/chat-ui-tools";
import {
  getCreateDocumentDraftPersistence,
  type CreateDocumentDraftPersistence,
} from "@/components/chat/create-document-draft-runtime";
import { useChatModelSelection } from "@/components/chat/use-chat-model-selection";
import type { DocxComments } from "@/components/docx/app-docx-editor";
import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { useAIKeyGate } from "@/components/require-ai-key";
import { ChatTitleRename } from "@/features/chat/components/chat-title-rename";
import { SuggestedFollowupChips } from "@/features/chat/components/suggested-followup-chips";
import { useChatSession } from "@/features/chat/hooks/use-chat-session";
import { useChatThreadRuntime } from "@/features/chat/hooks/use-chat-thread-runtime";
import { useChatUserContext } from "@/features/chat/hooks/use-chat-user-context";
import { buildChatRequestMessage } from "@/features/chat/lib/build-chat-request-message";
import { useChatRenameCommandStore } from "@/features/chat/lib/chat-rename-command-store";
import { startNewThreadCommandHandoff } from "@/features/chat/lib/start-new-thread-command-handoff";
import {
  resolveSuggestedPromptsAvailability,
  resolveSuggestedPromptsTurnOwner,
} from "@/features/chat/lib/suggested-prompts-availability";
import {
  applyChatModelChange,
  chatThreadOptions,
  chatThreadSuggestedPromptsOptions,
  chatThreadTitleOptions,
  fileChatThreadOptions,
  materializeFileChatThread,
} from "@/features/chat/queries";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { getTranslator } from "@/i18n/i18n-store";
import { getAnalytics } from "@/lib/analytics/provider";
import { ChatAnonymizationLayer } from "@/lib/anonymize/use-chat-anonymization-layer";
import { api } from "@/lib/api";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import {
  getChatSendMode,
  useChatAnonymized,
} from "@/lib/chat-anonymized-store";
import { useIsChatDraftEmpty } from "@/lib/chat-draft-store";
import {
  type DocxEditSafety,
  docxEditRepresentationForSelection,
  resolveActiveDocxEditModeState,
} from "@/lib/chat-edit-mode";
import {
  getChatEditModeSelection,
  useChatEditModeStore,
} from "@/lib/chat-edit-mode-store";
import {
  createChatThreadId,
  getChatThreadKey,
  type ChatThreadId,
  type ChatThreadRef,
} from "@/lib/chat-thread-ref";
import { isPlaceholderThreadTitle } from "@/lib/chat-thread-title";
import { detached } from "@/lib/detached";
import { unwrapEden } from "@/lib/errors/api";
import { runReservedChatCommand } from "@/lib/reserved-chat-commands";
import { toSafeId } from "@/lib/safe-id";

type ActiveFile = {
  docxEditSnapshot?:
    | (Pick<FolioAIEditSnapshot, "blocks"> & {
        canApplyEdits?: boolean | undefined;
      })
    | undefined;
  entityId: string;
  editable?: boolean | undefined;
  fileFieldId?: string | undefined;
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

type PreparedOperation = {
  /**
   * The operation as queued: folio's parsed op, re-keyed to {@link id} and
   * with inserted text cleaned of directive markers.
   */
  folio: FolioAIEditOperation;
  /**
   * Internal suggestion id, always generated: review-store entries must stay
   * unique across batches, and folio keeps a model-supplied operation id
   * verbatim (a model can reuse `op-1` on every call).
   */
  id: string;
  /** Id echoed to the model in `queued` / `skipped`: folio's operation id. */
  reportId: string;
};

// Defense-in-depth: even with the structural ops below, the model can
// still emit raw directive text inside `text` (older transcripts, or
// when it forgets to use the canonical op). Strip directive markers
// and unwrap `[[placeholders]]` so the text reads cleanly rather than
// landing in the doc as literal `@pagebreak` / `[[date]]` characters.
// Trim a leading `@directive` token from a line. Pure string-walking
// to avoid the regex backtracking warning the linter flags on
// `\s*`-flanked patterns even when the alternatives are fixed.
const DIRECTIVE_NAMES: readonly string[] = Object.freeze([
  "pagebreak",
  "signature",
  "signatures",
  "signature_block",
  "section",
  "paragraph",
  "clause",
  "schedule",
  "note",
  "recital",
  "recitals",
]);
const DIRECTIVE_NAME_CHAR_RE = /[a-z_]/iu;
const PLACEHOLDER_RE = /\[\[(?<inner>[^[\]]+?)\]\]/gu;
const CLAUSE_HEADING_RE = /^@clause +\d+ *"(?<title>[^"]*)" *$/iu;
const stripDirectivePrefix = (line: string): string => {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith("@")) {
    return line;
  }
  let nameEnd = 1;
  while (
    nameEnd < trimmed.length &&
    DIRECTIVE_NAME_CHAR_RE.test(trimmed[nameEnd] ?? "")
  ) {
    nameEnd += 1;
  }
  if (nameEnd === 1) {
    return line;
  }
  const directive = trimmed.slice(1, nameEnd).toLowerCase();
  if (!DIRECTIVE_NAMES.includes(directive)) {
    return line;
  }
  // Require a word boundary (whitespace or end-of-line) right after
  // the directive name so we don't strip e.g. `@paragraphical`.
  const afterName = trimmed[nameEnd];
  if (afterName !== undefined && afterName !== " " && afterName !== "\t") {
    return line;
  }
  return trimmed.slice(nameEnd).trimStart().trimEnd();
};

const cleanDirectiveText = (text: string): string => {
  const lines = text.split("\n").map((line) => {
    const clauseMatch = CLAUSE_HEADING_RE.exec(line);
    if (clauseMatch) {
      return clauseMatch.groups?.["title"] ?? "";
    }
    return stripDirectivePrefix(line);
  });
  // Collapse runs of empty lines so stripped directives don't leave
  // huge gaps.
  const collapsed: string[] = [];
  for (const line of lines) {
    if (line.length === 0 && collapsed.at(-1)?.length === 0) {
      continue;
    }
    collapsed.push(line);
  }
  return collapsed
    .join("\n")
    .replace(PLACEHOLDER_RE, (_, inner: string) => inner.trim())
    .trim();
};

/**
 * Fold an emptied `replaceBlock` into the canonical `deleteBlock` (so the
 * model never has to pick between two operations) and strip directive
 * markers from inserted text. Every other operation queues as parsed.
 */
const normalizeQueuedOperation = (
  operation: FolioAIEditOperation,
): FolioAIEditOperation => {
  switch (operation.type) {
    case "insertAfterBlock":
    case "insertBeforeBlock":
      return { ...operation, text: cleanDirectiveText(operation.text) };
    case "replaceBlock": {
      const text = cleanDirectiveText(operation.text);
      if (text.length > 0) {
        return { ...operation, text };
      }
      return {
        id: operation.id,
        type: "deleteBlock",
        blockId: operation.blockId,
        ...(operation.comment !== undefined && { comment: operation.comment }),
        ...(operation.severity !== undefined && {
          severity: operation.severity,
        }),
        ...(operation.area !== undefined && { area: operation.area }),
        ...(operation.precondition !== undefined && {
          precondition: operation.precondition,
        }),
      };
    }
    // Cell texts are model-written prose like an inserted paragraph, so the
    // same directive markers can reach them.
    case "insertTable":
      return {
        ...operation,
        rows: operation.rows.map((row) => row.map(cleanDirectiveText)),
      };
    // Queued as parsed. A `splitBlock` / `mergeBlockWithNext` separator is the
    // whitespace the paragraph break stood in for, not prose: stripping it
    // through `cleanDirectiveText` would trim away the one space the join is
    // there to insert.
    case "replaceInBlock":
    case "replaceRange":
    case "commentOnRange":
    case "formatRange":
    case "setBlockParagraphProperties":
    case "deleteBlock":
    case "splitBlock":
    case "mergeBlockWithNext":
    case "commentOnBlock":
    case "insertSignatureTable":
    case "deleteTable":
    case "insertTableRow":
    case "deleteTableRow":
    case "insertTableColumn":
    case "deleteTableColumn":
    case "mergeTableCells":
    case "splitTableCell":
      return operation;
    default:
      operation satisfies never;
      return panic(`Unhandled operation: ${String(operation)}`);
  }
};

const prepareOperations = (
  operations: readonly FolioAIEditOperation[],
): PreparedOperation[] =>
  operations.map((operation, index) => {
    const id = `ai-docx-${String(index + 1)}-${uuidv7()}`;
    return {
      folio: { ...normalizeQueuedOperation(operation), id },
      id,
      reportId: operation.id,
    };
  });

// The file-overlay `suggest_changes` options require `severity` / `area`,
// so folio's parser rejects a call without them; the fallbacks cover the
// contract's own optionality (a host queue can receive ops from elsewhere).
const inputOperationSeverity = (operation: {
  severity?: FolioAIEditSeverity | undefined;
}): FolioAIEditSeverity | "unspecified" => operation.severity ?? "unspecified";

const inputOperationArea = (operation: { area?: string | undefined }): string =>
  operation.area ?? REVIEW_UNSPECIFIED_AREA;

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
  const queuedIds: string[] = [];
  const skipped: { id: string; reason: "noopOperation" | "missingBlock" }[] =
    [];
  const items: ReviewSuggestion[] = prepared.flatMap(
    ({ id, reportId, folio }) => {
      // Drop true no-ops before they ever reach the panel: the model
      // occasionally emits `find === replace` (or replaceBlock text
      // identical to the source) as a side effect of running through
      // every block. Showing them as "X → X" cards is noise.
      if (isNoopReviewOperation(folio, blocksById)) {
        skipped.push({ id: reportId, reason: "noopOperation" });
        return [];
      }
      const preview = buildPreview(folio, blocksById);
      if (!preview) {
        skipped.push({ id: reportId, reason: "missingBlock" });
        return [];
      }
      queuedIds.push(reportId);
      const blockLabel = labelsById.get(folioOperationBlockId(folio));
      const base: ReviewSuggestion = {
        id,
        operationId: reportId,
        origin: REVIEW_SUGGESTION_ORIGIN.chat,
        blockId: folioOperationBlockId(folio),
        type: folio.type,
        summary: summarizeOperation(folio, blockLabel),
        preview,
        severity: inputOperationSeverity(folio),
        area: inputOperationArea(folio),
        status: "pending",
        applyMode: null,
        revisionIds: null,
        undoHandle: null,
        pendingOperation: folio,
        snapshot,
      };
      if (blockLabel !== undefined) {
        base.blockLabel = blockLabel;
      }
      const folioComment = folioOperationComment(folio);
      if (folioComment) {
        base.comment = folioComment.text;
      }
      return [base];
    },
  );

  useReviewStore.getState().appendSuggestions(entityId, items);

  // Auto-switch the inspector's tab for this entity to the document-review
  // facet with a teaching pulse, so the user immediately sees where the
  // proposals landed — they list there under "From chat", beside whatever a
  // review run found. Locating the tab by entityId rather than by tab id keeps
  // the chat overlay ignorant of inspector internals.
  const inspectorState = useInspectorTabsStore.getState();
  const tab = inspectorState.tabs.find(
    (candidate) => candidate.type === "pdf" && candidate.entityId === entityId,
  );
  if (tab) {
    inspectorState.setFileFacet(tab.id, "playbook", { pulse: true });
  }

  // `items` are the suggestions actually appended to the store (client
  // ids, folio op, comment, severity, area). The caller uses them to
  // build the background persist-create body; `queuedIds` stays the
  // model-facing echo.
  return { queuedIds, skipped, items };
};

type PersistQueuedSuggestionsOptions = {
  workspaceId: string;
  entityId: string;
  chatThreadId: ChatThreadId | undefined;
  items: readonly ReviewSuggestion[];
  /**
   * Live editor ref. A failed persist-window replay (below) rolls the
   * local accept/reject BACK to pending to match the still-pending server
   * row; undoing an already-applied editor op needs this ref.
   */
  docxEditorRef: RefObject<DocxEditorRef | null>;
};

/**
 * Persist just-queued suggestions server-side, then adopt the returned
 * server ids so a later accept / reject / revert writes the audit trail.
 *
 * Fire-and-forget and non-blocking: the in-memory review flow works
 * without this. On any failure it swallows (telemetry only) and leaves
 * the suggestions client-only with `persisted` false, so no resolve/
 * revert call ever fires for them — the graceful-degradation guarantee.
 * Client ids are echoed as `ref`; `reconcileServerIds` maps them back.
 */
const persistQueuedSuggestions = async ({
  workspaceId,
  entityId,
  chatThreadId,
  items,
  docxEditorRef,
}: PersistQueuedSuggestionsOptions): Promise<void> => {
  const suggestions = items.flatMap((item) =>
    item.pendingOperation === null
      ? []
      : [
          {
            ref: item.id,
            opPayload: item.pendingOperation,
            comment: item.comment ?? null,
            severity: item.severity,
            area: item.area,
          },
        ],
  );
  if (suggestions.length === 0) {
    return;
  }

  const result = await Result.tryPromise(async () => {
    const response = await api["docx-suggestions"]({ workspaceId })
      .entity({ entityId })
      .put({ suggestions, originThreadId: chatThreadId ?? null });
    return unwrapEden(response);
  });
  if (Result.isError(result)) {
    getAnalytics().captureError(result.error);
    return;
  }
  const refToId = Object.fromEntries(
    result.value.items.map(({ ref, id }) => [ref, id]),
  );
  useReviewStore.getState().reconcileServerIds(entityId, refToId);

  // Persist-window replay: the user can accept / reject a suggestion in the
  // gap between queueing it and this create response landing. Those
  // resolutions ran against a not-yet-`persisted` row, so they never hit
  // the server. Now that the rows exist (ids just reconciled in), replay any
  // that are already TERMINAL so the server matches the editor. Fires in
  // parallel; a single failure surfaces one toast + telemetry.
  //
  // A row still `"applying"` at this point (an accept that claimed the card
  // but hasn't run its zero-delay editor apply yet) is deliberately NOT
  // replayed here: `acceptOne` owns it end-to-end — after its unlock/paint
  // await it re-reads the row, follows this same id reconcile, and fires the
  // resolve itself once the apply lands. Replaying an in-flight `applying` row
  // would double-resolve it (and we don't yet know its final status /
  // appliedMode), so only `accepted` / `rejected` rows are eligible.
  // Widened to string: the create response ids are branded SafeIds, but the
  // review store keys suggestions by plain string id, so the membership test
  // below compares against `item.id: string`.
  const serverIds = new Set<string>(Object.values(refToId));
  const session = useReviewStore.getState().sessions[entityId];
  if (session === undefined) {
    return;
  }
  const replayTargets = session.filter(
    (item): item is ReviewSuggestion & { status: "accepted" | "rejected" } =>
      serverIds.has(item.id) &&
      (item.status === "accepted" || item.status === "rejected"),
  );
  if (replayTargets.length === 0) {
    return;
  }
  const replayResults = await Promise.all(
    replayTargets.map(async (item) => ({
      id: item.id,
      replayResult: await resolveDocxSuggestionRequest({
        workspaceId,
        entityId,
        suggestionId: item.id,
        status: item.status,
        appliedMode: item.applyMode ?? "tracked-changes",
      }),
    })),
  );
  const failedTargets = replayResults.filter(
    ({ replayResult }) => replayResult === "failed",
  );
  if (failedTargets.length === 0) {
    return;
  }

  // A `"failed"` replay left the local accept/reject applied while the
  // server row stays `pending`: a reload would restore an actionable copy
  // and let the same op apply twice. Roll each failed target back to
  // pending to match the still-pending server row. Read the CURRENT store
  // row (not the pre-replay snapshot) so we undo the op that actually
  // landed; an accepted row's editor op is reversed via its undoHandle.
  const currentSession = useReviewStore.getState().sessions[entityId];
  for (const { id } of failedTargets) {
    const row = currentSession?.find((candidate) => candidate.id === id);
    if (row === undefined) {
      continue;
    }
    if (row.status === "accepted") {
      if (row.undoHandle !== null) {
        docxEditorRef.current?.undoDocumentOperations(row.undoHandle);
      }
      useReviewStore.getState().updateSuggestion(entityId, id, {
        status: "pending",
        revisionIds: null,
        undoHandle: null,
        applyMode: null,
      });
    } else if (row.status === "rejected") {
      useReviewStore
        .getState()
        .updateSuggestion(entityId, id, { status: "pending" });
    }
  }

  getAnalytics().captureError(
    new Error("DOCX suggestion resolution replay failed to persist"),
  );
  stellaToast.add({
    title: getTranslator()("docxReview.persistFailed"),
    type: "error",
  });
};

// No tools are auto-blocked when an active file is present. The
// prompt already steers the model away from create-document for
// edit requests on the active file (in favour of `suggest_changes`);
// blocking it outright robbed users of the legitimate "create a new
// document from this chat" flow.
// The folio-agents comment MUTATION tools: client-executed against the live
// editor bridge, but behind approval (unlike the auto-run read tools). After
// the user approves, the overlay executes them via `executeFolioToolCall`, the
// same shape as `suggest_changes`. Names mirror the server-side
// registration in `folio-agent-tools.ts`; kept as local literals like the
// other tool names this surface matches on.
const FOLIO_AGENT_COMMENT_MUTATION_TOOL_NAMES = [
  FOLIO_AGENT_TOOL_NAMES.addComment,
  FOLIO_AGENT_TOOL_NAMES.replyComment,
  FOLIO_AGENT_TOOL_NAMES.resolveComment,
] as const satisfies readonly FolioAgentToolName[];
type FolioAgentCommentMutationToolName =
  (typeof FOLIO_AGENT_COMMENT_MUTATION_TOOL_NAMES)[number];

const isFolioAgentCommentMutationToolName = (
  toolName: ApprovalToolName,
): toolName is FolioAgentCommentMutationToolName =>
  FOLIO_AGENT_COMMENT_MUTATION_TOOL_NAMES.some(
    (folioToolName) => folioToolName === toolName,
  );

type ExecutableFolioAgentToolCall<TName extends FolioAgentToolName> = {
  input: FolioAgentToolInputByName[TName];
  name: TName;
};

/** Same options the API registered the file overlay's `suggest_changes` with. */
const FILE_OVERLAY_TOOL_OPTIONS: FolioAgentToolOptions = {
  suggestChanges:
    DOCX_SUGGEST_CHANGES_OPTIONS_BY_SURFACE[
      DOCX_SUGGESTION_SURFACE.fileOverlay
    ],
};

const executeTypedFolioToolCall = <TName extends FolioAgentToolName>(
  part: ExecutableFolioAgentToolCall<TName>,
  bridge: FolioAgentBridge,
) =>
  executeFolioToolCall(
    part.name,
    part.input,
    bridge,
    FILE_OVERLAY_TOOL_OPTIONS,
  );

// Stable empty context returned by `getContextMatterIds` before the picker
// has seeded (its state is `string[] | null`). A named constant, not a `?? []`
// literal: an unseeded thread has no selected matters, which is a real state,
// not a structural invariant to panic on.
const UNSEEDED_CONTEXT_MATTER_IDS: string[] = [];
const EMPTY_DOCX_COMMENTS: DocxComments = [];
const EMPTY_SNAPSHOT_BLOCKS: FolioAIEditSnapshot["blocks"] = [];

const normalizeDocxComments = (
  comments: DocxComments | null | undefined,
): DocxComments => {
  if (comments === null || comments === undefined) {
    return EMPTY_DOCX_COMMENTS;
  }
  return comments;
};

type FileChatOverlayProps = {
  /** Workspace this viewer belongs to. Scopes the thread + mention sources. */
  workspaceId?: string | undefined;
  /** Explicit thread id for non-file previews and newly-created chat sessions. */
  chatThreadId?: ChatThreadId | undefined;
  /**
   * Surfaced to the model via the chat transport so prompts can
   * reference "the file you're looking at" and tools can resolve
   * its entity. Optional — when omitted the model still works
   * fine but loses the file-context hint.
   */
  activeFile?: ActiveFile | undefined;
  activeDraft?:
    | {
        fileName: string;
        originChatMessageId: string;
        originChatThreadId: ChatThreadId;
        toolCallId: string;
      }
    | undefined;
  /** The persistence lifecycle owns this draft chat while it is being saved. */
  draftPersistence: CreateDocumentDraftPersistence;
  activeExternal?: ActiveExternal | undefined;
  docxEditorRef?: RefObject<DocxEditorRef | null> | undefined;
  docxEditable?: boolean | undefined;
  /**
   * DOCX rewrite-safety. `unsafe` → "View only" chip + no AI edit tool;
   * `checking` (probe pending) → no AI edit tool yet, so a prompt sent in that
   * window can't auto-edit an eventually-unsafe document. Defaults to `safe`.
   */
  docxEditSafety?: DocxEditSafety | undefined;
  requestDocxEditMode?: (() => boolean | Promise<boolean>) | undefined;
  /**
   * The host's controlled `DocxEditor` `comments` state. The folio-agents
   * comment tools (`read_comments`, `add_comment`, `reply_comment`,
   * `resolve_comment`) drive the editor bridge, whose `getComments` reads this
   * and whose `setComments` calls {@link onDocxCommentsChange}. Undefined on
   * surfaces that do not wire the round-trip (the comment tools then read/write
   * an empty list, matching a document with no host comment state).
   */
  docxComments?: DocxComments | undefined;
  onDocxCommentsChange?: ((comments: DocxComments) => void) | undefined;
  /**
   * Invoked when the user explicitly starts a new thread from the
   * overlay UI. Owners should swap the `chatThreadId` they pass in
   * for a fresh value.
   */
  onNewThread: (threadId: ChatThreadId) => void;
  /** Called only after the server-persisted chat history proves this overlay
   * thread owns the active generated-document draft. */
  onActiveDraftChatBound?: ((threadId: ChatThreadId) => void) | undefined;
};

const hasPersistedActiveDraftChatBinding = ({
  activeDraft,
  messages,
}: {
  activeDraft: NonNullable<FileChatOverlayProps["activeDraft"]>;
  messages: readonly PersistedChatMessage[];
}): boolean =>
  messages.some((message) => {
    const context = message.metadata?.activeDraftContext;
    return (
      context?.type === "generated-document" &&
      context.originChatMessageId === activeDraft.originChatMessageId &&
      context.originChatThreadId === activeDraft.originChatThreadId &&
      context.toolCallId === activeDraft.toolCallId
    );
  });

const fallback = (
  <div
    aria-hidden="true"
    className="pointer-events-none absolute inset-x-0 bottom-8 flex justify-center"
  >
    <LoaderCircleIcon className="text-muted-foreground size-4 animate-spin" />
  </div>
);

export const FileChatOverlay = ({
  workspaceId,
  chatThreadId,
  activeFile,
  activeDraft,
  draftPersistence,
  activeExternal,
  docxEditable,
  docxEditSafety,
  docxEditorRef,
  docxComments,
  onDocxCommentsChange,
  onNewThread,
  onActiveDraftChatBound,
  requestDocxEditMode,
}: FileChatOverlayProps) => {
  if (chatThreadId === undefined) {
    const fileFieldId = activeFile?.fileFieldId;
    if (
      workspaceId === undefined ||
      activeFile === undefined ||
      fileFieldId === undefined
    ) {
      return null;
    }

    return (
      <Suspense fallback={fallback}>
        <ResolvedFileChatOverlay
          activeFile={{ ...activeFile, fileFieldId }}
          draftPersistence={draftPersistence}
          docxComments={docxComments}
          docxEditable={docxEditable}
          docxEditSafety={docxEditSafety}
          docxEditorRef={docxEditorRef}
          onDocxCommentsChange={onDocxCommentsChange}
          onNewThread={onNewThread}
          requestDocxEditMode={requestDocxEditMode}
          workspaceId={workspaceId}
        />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={fallback}>
      <FileChatOverlayInner
        activeExternal={activeExternal}
        activeDraft={activeDraft}
        draftPersistence={draftPersistence}
        activeFile={activeFile}
        chatThreadId={chatThreadId}
        docxComments={docxComments}
        docxEditable={docxEditable}
        docxEditSafety={docxEditSafety}
        docxEditorRef={docxEditorRef}
        onDocxCommentsChange={onDocxCommentsChange}
        onActiveDraftChatBound={onActiveDraftChatBound}
        onNewThread={onNewThread}
        requestDocxEditMode={requestDocxEditMode}
        workspaceId={workspaceId}
      />
    </Suspense>
  );
};

type ResolvedFileChatOverlayProps = Omit<
  FileChatOverlayProps,
  "activeExternal" | "activeFile" | "chatThreadId" | "workspaceId"
> & {
  activeFile: ActiveFile & { fileFieldId: string };
  workspaceId: string;
};

const ResolvedFileChatOverlay = ({
  activeFile,
  docxComments,
  docxEditable,
  docxEditSafety,
  docxEditorRef,
  draftPersistence,
  onDocxCommentsChange,
  onNewThread,
  requestDocxEditMode,
  workspaceId,
}: ResolvedFileChatOverlayProps) => {
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const queryClient = useQueryClient();
  const fileThreadKey = {
    entityId: activeFile.entityId,
    fieldId: activeFile.fileFieldId,
    workspaceId,
  };
  // Must match FileChatOverlayInner's own `hasDocxEditSurface` below
  // (same `docxEditorRef` prop, and `activeFile` is always defined
  // here) so the cache entry this query seeds lands under the same
  // key that overlay's chatThreadOptions lookup will use.
  const hasDocxEditSurface = docxEditorRef !== undefined;
  const threadOptions = fileChatThreadOptions({
    activeOrganizationId,
    key: fileThreadKey,
    hasDocxEditSurface,
  });
  const { data: fileThreadBinding } = useSuspenseQuery(threadOptions);

  // First-send gate: persists the thread (row + file mapping) the read-only
  // lookup above deliberately did not create. Reads the cache instead of the
  // captured binding so a second submit after a failed send does not repeat
  // the POST once materialization has succeeded.
  const ensureFileThreadPersisted = useLatestCallback(
    async (): Promise<ChatThreadId> => {
      const current = queryClient.getQueryData(threadOptions.queryKey);
      const binding = current ?? fileThreadBinding;
      if (binding.threadExists) {
        return binding.threadId;
      }
      const materialized = await materializeFileChatThread({
        activeOrganizationId,
        client: queryClient,
        draftThreadId: binding.threadId,
        hasDocxEditSurface,
        key: fileThreadKey,
      });
      return materialized.threadId;
    },
  );

  return (
    <FileChatOverlayInner
      activeFile={activeFile}
      chatThreadId={fileThreadBinding.threadId}
      draftPersistence={draftPersistence}
      docxComments={docxComments}
      docxEditable={docxEditable}
      docxEditSafety={docxEditSafety}
      docxEditorRef={docxEditorRef}
      ensureFileThreadPersisted={ensureFileThreadPersisted}
      onDocxCommentsChange={onDocxCommentsChange}
      onNewThread={onNewThread}
      requestDocxEditMode={requestDocxEditMode}
      workspaceId={workspaceId}
    />
  );
};

type FileChatOverlayInnerProps = Omit<FileChatOverlayProps, "chatThreadId"> & {
  chatThreadId: ChatThreadId;
  /** Present only for workspace-file overlays: persists the file's thread
   *  before the first message is sent (see `materializeFileChatThread`).
   *  Resolves with the persisted thread id, which is normally the mounted
   *  draft id itself. */
  ensureFileThreadPersisted?: (() => Promise<ChatThreadId>) | undefined;
};

const getFileChatThreadRef = (
  chatThreadId: ChatThreadId,
  workspaceId: string | undefined,
): ChatThreadRef =>
  workspaceId === undefined
    ? { scope: "global", threadId: chatThreadId }
    : {
        scope: "workspace",
        threadId: chatThreadId,
        workspaceId,
      };

const useFileChatReviewState = ({
  activeDraft,
  activeFile,
}: Pick<FileChatOverlayInnerProps, "activeDraft" | "activeFile">) => {
  let reviewEntityId: string | undefined;
  if (activeFile !== undefined) {
    reviewEntityId = resolveFileReviewSessionId({
      type: "file",
      entityId: activeFile.entityId,
    });
  } else if (activeDraft !== undefined) {
    reviewEntityId = resolveFileReviewSessionId({
      type: "draft",
      toolCallId: activeDraft.toolCallId,
    });
  } else {
    reviewEntityId = resolveFileReviewSessionId({ type: "none" });
  }
  const hasPendingReview = useReviewStore((state) => {
    if (reviewEntityId === undefined) {
      return false;
    }
    return (
      state.sessions[reviewEntityId]?.some(
        (item) => item.status === "pending" || item.status === "applying",
      ) === true
    );
  });
  return { hasPendingReview, reviewEntityId };
};

const useFileChatDocxLifecycle = ({
  activeDraft,
  activeFile,
  docxEditorRef,
  editorReady,
  hasDocxEditSurface,
  setEditorReady,
}: Pick<
  FileChatOverlayInnerProps,
  "activeDraft" | "activeFile" | "docxEditorRef"
> & {
  editorReady: boolean;
  hasDocxEditSurface: boolean;
  setEditorReady: Dispatch<SetStateAction<boolean>>;
}) => {
  const lastSentDocxEditSnapshotRef = useRef<FolioAIEditSnapshot | null>(null);
  const activeDocumentKey = activeFile
    ? `${activeFile.entityId}:${activeFile.fileFieldId ?? ""}`
    : activeDraft?.toolCallId;
  const [readyForDocumentKey, setReadyForDocumentKey] =
    useState(activeDocumentKey);
  if (activeDocumentKey !== readyForDocumentKey) {
    setReadyForDocumentKey(activeDocumentKey);
    setEditorReady(false);
  }
  useExternalSyncEffect(() => {
    lastSentDocxEditSnapshotRef.current = null;
    return undefined;
  }, [activeDocumentKey]);
  useExternalSyncEffect(() => {
    if (editorReady || !hasDocxEditSurface) {
      return undefined;
    }
    const ensure = () =>
      docxEditorRef?.current?.ensureEditorView({ focus: false });
    ensure();
    const probe = () => {
      if (docxEditorRef?.current?.createAIEditSnapshot()) {
        setEditorReady(true);
        return true;
      }
      return false;
    };
    if (probe()) {
      return undefined;
    }
    const id = window.setInterval(() => {
      ensure();
      if (probe()) {
        window.clearInterval(id);
      }
    }, 80);
    const fallbackTimer = window.setTimeout(() => {
      window.clearInterval(id);
      setEditorReady(true);
    }, 3000);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(fallbackTimer);
    };
  }, [editorReady, hasDocxEditSurface, docxEditorRef, setEditorReady]);
  return { lastSentDocxEditSnapshotRef };
};

const useFileChatPlaceholder = ({
  activeDraft,
  activeExternal,
  activeFile,
  docxEditSafety,
}: Pick<
  FileChatOverlayInnerProps,
  "activeDraft" | "activeExternal" | "activeFile" | "docxEditSafety"
>) => {
  const t = useTranslations();
  if (activeDraft !== undefined) {
    return {
      placeholder: t("chat.editableFilePlaceholder", {
        fileName: activeDraft.fileName,
      }),
      placeholderAction: t("chat.editableFilePlaceholderAction"),
      sourceLabel: activeDraft.fileName,
    };
  }
  if (activeFile !== undefined) {
    const canOfferEdit =
      activeFile.editable === true && docxEditSafety !== "unsafe";
    return {
      placeholder: t(
        canOfferEdit ? "chat.editableFilePlaceholder" : "chat.filePlaceholder",
        { fileName: activeFile.fileName },
      ),
      placeholderAction: t(
        canOfferEdit
          ? "chat.editableFilePlaceholderAction"
          : "chat.filePlaceholderAction",
      ),
      sourceLabel: activeFile.fileName,
    };
  }
  if (activeExternal !== undefined) {
    return {
      placeholder: t("chat.externalSourcePlaceholder", {
        title: activeExternal.title,
      }),
      placeholderAction: t("chat.externalSourcePlaceholderAction"),
      sourceLabel: activeExternal.title,
    };
  }
  return {
    placeholder: undefined,
    placeholderAction: undefined,
    sourceLabel: undefined,
  };
};

const FileChatOverlayInner = ({
  workspaceId,
  chatThreadId,
  activeFile,
  activeDraft,
  draftPersistence,
  activeExternal,
  docxEditable,
  docxEditSafety,
  docxEditorRef,
  docxComments,
  ensureFileThreadPersisted,
  onDocxCommentsChange,
  onActiveDraftChatBound,
  onNewThread,
}: FileChatOverlayInnerProps) => {
  const t = useTranslations();
  const capturePromptSubmitError = useCallback(
    (error: unknown): void => {
      if (ChatSubmitPreservedError.is(error)) {
        return;
      }
      getAnalytics().captureError(error);
      stellaToast.add({
        title: t("common.somethingWentWrong"),
        type: "error",
      });
    },
    [t],
  );
  const activeOrganizationId = useAuthenticatedUser().activeOrganizationId;
  const userContext = useChatUserContext();
  const getUserContext = useLatestCallback(() => userContext);
  const threadRef = useMemo(
    () => getFileChatThreadRef(chatThreadId, workspaceId),
    [chatThreadId, workspaceId],
  );
  // Per-send anonymization now reads the shared per-thread store keyed by
  // `threadRef`, same as every other chat surface: the dock's shield
  // shows `useChatAnonymized(threadRef)`, the transport reads
  // `getChatSendMode(threadRef)`, and `ChatAnonymizationLayer` drives the
  // in-editor highlight cue — one source, so display and send agree.
  const anonymized = useChatAnonymized(threadRef);
  const [composerFocused, setComposerFocused] = useState(false);
  const getSendMode = useLatestCallback(() => getChatSendMode(threadRef));
  // Context matters this file chat draws on. Same plumbing as the main
  // chat and inspector: local state is seeded from the server's persisted
  // set (or, for a fresh thread, the file's own matter), the picker mutates
  // it directly, and the transport pulls the latest value via
  // `getContextMatterIds` on every send — so the displayed selection and
  // the sent context are provably one source. Null until seeded below.
  const [contextMatterIds, setContextMatterIds] = useState<string[] | null>(
    null,
  );
  const [seededContextForThreadId, setSeededContextForThreadId] = useState<
    string | null
  >(null);
  const getContextMatterIds = useLatestCallback(
    () => contextMatterIds ?? UNSEEDED_CONTEXT_MATTER_IDS,
  );
  // Seeded with the shared empty constant instead of normalizing during
  // render (the initializer would rebuild and discard the value every
  // render); the layout effect below fills it before anything reads it.
  const latestDocxCommentsRef = useRef<DocxComments>(EMPTY_DOCX_COMMENTS);
  useLayoutEffect(() => {
    latestDocxCommentsRef.current = normalizeDocxComments(docxComments);
  }, [docxComments]);
  const hasDocxEditSurface =
    (activeFile !== undefined || activeDraft !== undefined) &&
    docxEditorRef !== undefined;
  // Whether the floating DOCX `ReviewBar` is showing for this entity — it
  // renders while any suggestion is pending/applying (mirrors the bar's own
  // `isPending` gate). When it is, the thread card lifts above the bar so the
  // two floating surfaces never overlap.
  const { hasPendingReview, reviewEntityId } = useFileChatReviewState({
    activeDraft,
    activeFile,
  });
  const editModeOptionId = useChatEditModeStore((state) => state.optionId);
  const setEditModeOptionId = useChatEditModeStore(
    (state) => state.setOptionId,
  );
  const activeDocxEditModeState = resolveActiveDocxEditModeState({
    activeFileEditable: activeDraft === undefined ? activeFile?.editable : true,
    docxEditable,
    hasDocxEditSurface,
    safety: docxEditSafety ?? "safe",
    selection: getChatEditModeSelection(),
  });
  const getLatestActiveDocxEditSelection = useLatestCallback(() => {
    const state = resolveActiveDocxEditModeState({
      activeFileEditable:
        activeDraft === undefined ? activeFile?.editable : true,
      docxEditable,
      hasDocxEditSurface,
      safety: docxEditSafety ?? "safe",
      selection: getChatEditModeSelection(),
    });
    return state.type === "unavailable" ? null : state.selection;
  });
  const canSelectEditMode = activeDocxEditModeState.type === "selectable";
  // Folio's PM view exists almost immediately after DocxBrowserEditor
  // mounts but there is a sub-100ms window where the ref is set but
  // `createAIEditSnapshot()` still returns null. Sending a message in
  // that window means the model sees no editable blocks and replies
  // with "editor is loading" instead of doing real work. Poll until
  // the first non-null snapshot lands, then stop — once ready stays
  // ready for the lifetime of the editor.
  // Initialize from the ref so a transition-induced remount of an
  // already-ready editor starts ready (without this, useTransition's
  // Suspense swap unmounts + remounts this subtree with fresh state,
  // and the poller racing with a second rerender can leave the gate
  // stuck closed even though the underlying view is live).
  // Reset readiness when the active file changes (the new doc has its
  // own mount cycle). Done during render rather than in an effect: the
  // editor now creates its hidden view synchronously inside
  // `ensureEditorView`, so the probe below flips `editorReady` true in
  // the same commit. A separate reset effect runs after that probe and
  // would clobber it back to false (the `false -> true -> false` batch
  // nets to the committed value, so React bails and the probe never
  // re-runs), leaving the bar stuck on "loading" with no fallback armed.
  // Key readiness to the specific document, not just the entity: one entity can
  // hold several file fields, so an entity-only key would keep `editorReady`
  // true when switching to another file/version on the same entity and skip the
  // snapshot poll for the newly mounted editor.
  // eslint-disable-next-line react/refs -- mount-time seed of readiness from the imperative Folio editor instance so a transition-induced remount of an already-ready editor starts ready; the ref read runs once in the useState initializer
  const [editorReady, setEditorReady] = useState(() =>
    Boolean(docxEditorRef?.current?.createAIEditSnapshot()),
  );
  const { lastSentDocxEditSnapshotRef } = useFileChatDocxLifecycle({
    activeDraft,
    activeFile,
    docxEditorRef,
    editorReady,
    hasDocxEditSurface,
    setEditorReady,
  });

  // Subscribe to the inspector chip's pulse channel so the bar
  // glows when the user clicks the AI-suggestions facet.
  const attentionPulseSeq = useReviewStore((state) =>
    activeFile ? state.chatInputPulse[activeFile.entityId] : undefined,
  );
  const getActiveFile = useLatestCallback(() => {
    if (!activeFile) {
      lastSentDocxEditSnapshotRef.current = null;
      return undefined;
    }

    const snapshot = docxEditorRef?.current?.createAIEditSnapshot() ?? null;
    lastSentDocxEditSnapshotRef.current = snapshot;

    if (getLatestActiveDocxEditSelection() === null) {
      return { ...activeFile, supportsDocxEdits: false };
    }

    if (!snapshot) {
      return { ...activeFile, supportsDocxEdits: true };
    }

    return {
      ...activeFile,
      docxEditSnapshot: {
        blocks: withBlockTextHashes(snapshot),
        canApplyEdits: Boolean(docxEditable),
      },
      supportsDocxEdits: true,
    };
  });
  const getActiveDraft = useLatestCallback(() => {
    if (!activeDraft) {
      return panic("Active draft context requested without an active draft");
    }
    const snapshot =
      docxEditorRef?.current?.createAIEditSnapshot() ??
      lastSentDocxEditSnapshotRef.current;
    if (snapshot === null) {
      return panic("Active draft context requested before its snapshot exists");
    }
    lastSentDocxEditSnapshotRef.current = snapshot;
    return {
      ...activeDraft,
      docxEditSnapshot: {
        blocks: withBlockTextHashes(snapshot),
        canApplyEdits: Boolean(docxEditable),
      },
    };
  });
  const getActiveExternal = useLatestCallback(() => activeExternal);
  /**
   * Park a `suggest_changes` batch in the review panel. The editor is not
   * touched here: the user reviews each suggestion in the panel and the
   * unlock prompt only fires when the user actually clicks Accept.
   */
  const queueSuggestChangesBatch = useLatestCallback(
    (batch: FolioDocumentOperationBatch): FolioDocumentOperationResult => {
      if (reviewEntityId === undefined) {
        const skipped = batch.operations.map(({ id }) => ({
          id,
          reason: "documentNotEditable" as const,
        }));
        return {
          version: batch.version,
          status: "rejected",
          applied: [],
          skipped,
          issues: getFolioDocumentOperationIssues(batch.operations, skipped),
          receipts: [],
          undoHandle: null,
        };
      }

      const prepared = prepareOperations(batch.operations);
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
      const { queuedIds, skipped, items } = queueReviewSuggestions({
        entityId: reviewEntityId,
        prepared,
        snapshotBlocks: lastSnapshot
          ? lastSnapshot.blocks
          : EMPTY_SNAPSHOT_BLOCKS,
        snapshot: lastSnapshot,
      });
      // Persist the queued batch in the background so the suggestions
      // survive a reload with an audit trail. Non-blocking: the model
      // gets its `queued` ids synchronously below, and a persist failure
      // degrades gracefully to the in-memory-only flow (no server ids =>
      // `persisted` stays false => resolve/revert never call the server).
      if (
        docxEditorRef !== undefined &&
        activeFile !== undefined &&
        workspaceId !== undefined &&
        items.length > 0
      ) {
        detached(
          persistQueuedSuggestions({
            workspaceId,
            entityId: activeFile.entityId,
            chatThreadId,
            items,
            docxEditorRef,
          }),
          "file-chat-overlay.persist-queued-suggestions",
        );
      }
      const queued = queuedIds.map((id) => ({ id }));
      return {
        version: batch.version,
        status: "queued",
        applied: [],
        queued,
        skipped,
        issues: getFolioDocumentOperationIssues(batch.operations, skipped),
        receipts: getFolioDocumentOperationReceipts(batch.operations, queued),
        undoHandle: null,
      };
    },
  );
  // Active-file mode currently adds no approval blocks. Leave the context
  // value absent until a real blocked tool exists.
  const blockedApprovalTools = undefined;

  const getEditApplyMode =
    activeDocxEditModeState.type === "unavailable"
      ? undefined
      : () => getLatestActiveDocxEditSelection()?.editApplyMode ?? "manual";
  const getDocxEditRepresentation =
    activeDocxEditModeState.type === "unavailable"
      ? undefined
      : () => {
          const selection = getLatestActiveDocxEditSelection();
          return selection
            ? docxEditRepresentationForSelection(selection)
            : undefined;
        };
  const chatThreadContext = {
    allowMissingThread: true,
    getContextMatterIds,
    getSendMode,
    getUserContext,
    ...(activeExternal ? { getActiveExternal: () => getActiveExternal() } : {}),
    ...(activeDraft ? { getActiveDraft: () => getActiveDraft() } : {}),
    ...(activeFile ? { getActiveFile: () => getActiveFile() } : {}),
    ...(hasDocxEditSurface
      ? {
          getDocxSuggestionSurface: () => DOCX_SUGGESTION_SURFACE.fileOverlay,
        }
      : {}),
    ...(getEditApplyMode === undefined
      ? {}
      : { getEditApplyMode, getDocxEditRepresentation }),
  };
  const threadQueryOptions = chatThreadOptions({
    activeOrganizationId,
    key: threadRef,
    context: chatThreadContext,
  });
  const { data } = useSuspenseQuery(threadQueryOptions);
  const hasPersistedDraftChatBinding =
    activeDraft !== undefined &&
    hasPersistedActiveDraftChatBinding({
      activeDraft,
      messages: data.messages,
    });
  useExternalSyncEffect(() => {
    if (!hasPersistedDraftChatBinding) {
      return undefined;
    }
    onActiveDraftChatBound?.(chatThreadId);
    return undefined;
  }, [chatThreadId, hasPersistedDraftChatBinding, onActiveDraftChatBound]);
  const queryClient = useQueryClient();
  // Persists the composer (+) menu's Models submenu selection into this
  // thread's cache, mirroring `ChatThreadPage`'s wiring so the file-chat (+)
  // menu keeps the same functionality as the main chat's.
  const modelSelection = useChatModelSelection({
    onPersisted: ({ model, reasoningEffort }) => {
      applyChatModelChange({
        model,
        reasoningEffort,
        queryClient,
        queryKey: threadQueryOptions.queryKey,
        threadId: toSafeId<"chatThread">(threadRef.threadId),
      });
    },
    threadRef,
  });
  const chat = useChatThreadRuntime({
    activeOrganizationId,
    context: chatThreadContext,
    data,
    key: threadRef,
  });
  // Seed the picker once per thread. Prefer the server's persisted set;
  // for a brand-new file thread (empty set) fall back to the file's own
  // matter so "the matter this file lives in" is the default context. A
  // global file preview (no workspace) seeds empty and lets the user add
  // context matters explicitly.
  useExternalSyncEffect(() => {
    if (seededContextForThreadId === chatThreadId) {
      return;
    }
    setSeededContextForThreadId(chatThreadId);
    const ownMatter = workspaceId !== undefined ? [workspaceId] : [];
    setContextMatterIds(
      data.contextMatterIds.length > 0 ? data.contextMatterIds : ownMatter,
    );
  }, [
    chatThreadId,
    data.contextMatterIds,
    seededContextForThreadId,
    workspaceId,
  ]);

  const {
    error,
    messages,
    olderCursor,
    isLoadingOlder,
    loadOlder,
    loadOlderError,
    resendLatestMessage,
    sendMessage,
    queuedMessages,
    removeQueuedMessage,
    stop,
    isGenerating,
    turnAbandoned,
    alwaysApprovedTools,
    conversationApprovedTools,
    handleApprove,
    handleAllowInConversation,
    handleDeny,
    handleAskUserSubmit,
    handleAskUserEditAndRerun,
    handleAlwaysAllow,
    handleCreateDocumentResolve,
    handleOpenCreateDocumentDraft,
    handleOpenCreatedDocument,
    createDocumentMatters,
    isLoadingCreateDocumentMatters,
    addToolResult,
    streamdownComponents,
    approvalPendingMessageId,
  } = useChatSession({
    chat,
    conversationId: threadRef.threadId,
    getContextMatterIds,
    getDocxEditRepresentation,
    getEditApplyMode,
    getSendMode,
    initialOlderCursor: data.olderCursor,
    threadRef,
    workspaceId,
  });
  const { ensureAIAvailable, openIfAIUnavailable } = useAIKeyGate();
  const [panelOpen, setPanelOpen] = useState(false);
  const isDraftChatFrozen = (): boolean =>
    activeDraft !== undefined &&
    getCreateDocumentDraftPersistence(activeDraft.toolCallId).status ===
      "saving";
  const handlePromptSubmit = useLatestCallback(
    async ({
      prompt,
      files,
    }: {
      prompt: string;
      files: ChatDraftAttachment[];
    }) => {
      if (isDraftChatFrozen()) {
        return;
      }
      if (!(await ensureAIAvailable())) {
        return;
      }
      // Don't let a model just chosen from the (+) Models submenu race the
      // send: wait for its PATCH to settle (already toasted on failure) and
      // abort so the request can't run against the previous thread model.
      if (Result.isError(await modelSelection.awaitPendingSelection())) {
        return;
      }

      // A workspace-file overlay mounts on a lookup that deliberately
      // creates nothing; the thread (row + file mapping) is persisted here,
      // on the first real message. The persisted id normally IS the
      // mounted draft id; a different id means another session
      // materialized this file's thread first, the caches have been
      // rebound to it, and the preserved throw keeps the typed draft in
      // the composer for a retry against the rebound thread.
      if (ensureFileThreadPersisted !== undefined) {
        const persistedThreadId = await ensureFileThreadPersisted();
        if (persistedThreadId !== threadRef.threadId) {
          stellaToast.add({
            title: t("chat.fileThreadRebound"),
            type: "info",
          });
          throw new ChatSubmitPreservedError({
            message:
              "File thread rebound to a concurrently created thread; draft preserved for retry",
            restoreThreadKey: getChatThreadKey(
              threadRef.scope === "workspace"
                ? {
                    scope: "workspace",
                    threadId: persistedThreadId,
                    workspaceId: threadRef.workspaceId,
                  }
                : { scope: "global", threadId: persistedThreadId },
            ),
          });
        }
      }

      // Always pop the thread open on send, even if the user
      // minimised it earlier — they're sending a new prompt
      // and want to see the response stream in.
      setPanelOpen(true);
      await sendMessage(await buildChatRequestMessage({ files, html: prompt }));
    },
  );

  useExternalSyncEffect(() => {
    openIfAIUnavailable();
  }, [openIfAIUnavailable]);

  const {
    placeholder: filePlaceholder,
    placeholderAction: filePlaceholderAction,
    sourceLabel: filePlaceholderSourceLabel,
  } = useFileChatPlaceholder({
    activeDraft,
    activeExternal,
    activeFile,
    docxEditSafety,
  });

  // Check eligibility for suggested prompts using draft state (avoids
  // unnecessary API calls when user is typing).
  const lastMessage = messages.at(-1);
  const [editingAskUserToolCallIds, setEditingAskUserToolCallIds] = useState<
    ReadonlySet<string>
  >(() => new Set<string>());
  const handleAskUserEditingChange = useCallback(
    (toolCallId: string, isEditing: boolean) => {
      setEditingAskUserToolCallIds((current) => {
        if (current.has(toolCallId) === isEditing) {
          return current;
        }
        const next = new Set(current);
        if (isEditing) {
          next.add(toolCallId);
        } else {
          next.delete(toolCallId);
        }
        return next;
      });
    },
    [],
  );
  const editorIsInitiallyEmpty = useIsChatDraftEmpty(threadRef);
  const suggestedPromptsAvailability = resolveSuggestedPromptsAvailability({
    editorIsEmpty: editorIsInitiallyEmpty,
    error,
    isGenerating,
    lastMessage: lastMessage ?? null,
    turnAbandoned,
    turnOwner: resolveSuggestedPromptsTurnOwner({
      approvalPendingMessageId,
      hasReopenedAskUser: editingAskUserToolCallIds.size > 0,
      lastMessage: lastMessage ?? null,
    }),
  });
  const lastMessageId =
    suggestedPromptsAvailability.status === "eligible"
      ? suggestedPromptsAvailability.lastMessageId
      : "";
  const { data: suggestedPromptsData } = useQuery(
    chatThreadSuggestedPromptsOptions({
      activeOrganizationId,
      enabled: suggestedPromptsAvailability.status === "eligible",
      lastMessageId,
      threadRef,
    }),
  );
  const suggestedPrompts =
    suggestedPromptsAvailability.status === "eligible" && suggestedPromptsData
      ? suggestedPromptsData.prompts
      : [];
  const suggestedFollowupPrompt = suggestedPrompts.at(0) ?? undefined;

  const editorController = useChatEditor({
    placeholder: filePlaceholder,
    suggestedFollowupPrompt,
    threadRef,
  });
  // Focus the composer when the user explicitly starts a new thread,
  // so they can type the first message without an extra click. The
  // initial mount is skipped (entering the document should not steal
  // focus from whatever the user was doing).
  const previousChatThreadIdRef = useRef(chatThreadId);
  const shouldFocusComposerAfterNewThreadRef = useRef(false);
  const focusController = editorController.focus;
  const editorInstance = editorController.editor;
  useExternalSyncEffect(() => {
    if (previousChatThreadIdRef.current === chatThreadId) {
      return undefined;
    }
    if (!shouldFocusComposerAfterNewThreadRef.current) {
      previousChatThreadIdRef.current = chatThreadId;
      return undefined;
    }
    if (!editorInstance || editorInstance.isDestroyed) {
      // The TipTap editor for the new thread isn't mounted yet; wait
      // for the next render to retry (this effect re-runs when
      // `editorInstance` becomes non-null).
      return undefined;
    }
    previousChatThreadIdRef.current = chatThreadId;
    shouldFocusComposerAfterNewThreadRef.current = false;
    // rAF lets TipTap's DOM finish settling so `focus()` lands; without
    // this, focus is silently dropped on the just-remounted instance.
    // Re-check the editor inside the callback — between scheduling and
    // firing, the user might have closed the overlay or swapped threads
    // again, destroying the instance we captured.
    const id = requestAnimationFrame(() => {
      if (editorInstance.isDestroyed) {
        return;
      }
      focusController();
    });
    return () => {
      cancelAnimationFrame(id);
    };
  }, [chatThreadId, editorInstance, focusController]);
  const canSubmitWithCurrentDocxSnapshot = useLatestCallback(() => {
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

  // Build a folio-agents bridge over the live editor ref plus the host's
  // controlled `comments` state. Both the read-tool auto-run watcher and the
  // comment-mutation approval handler drive the same bridge, so `read_comments`
  // sees the same threads `add_comment` / `reply_comment` / `resolve_comment`
  // write. Returns null before the editor view mounts. The comments ref is
  // updated synchronously on writes so back-to-back approved mutations compose
  // before React commits the parent controlled-state update.
  const createFolioAgentBridge = useLatestCallback(() => {
    const ref = docxEditorRef?.current;
    if (!ref) {
      return null;
    }
    return createEditorRefBridge({
      ref,
      author: userContext.wordEditAuthorName,
      getComments: () => latestDocxCommentsRef.current,
      setComments: (comments) => {
        latestDocxCommentsRef.current = comments;
        onDocxCommentsChange?.(comments);
      },
    });
  });

  // `suggest_changes` runs through a review-queue bridge: the live editor
  // bridge for everything else, but `applyDocumentOperations` parks the
  // batch in the review panel instead of writing. `snapshot()` returns the
  // snapshot the model was shown, so folio stamps each operation's
  // precondition against the text the model actually read; the accept-time
  // apply re-checks it against the live document.
  const createReviewQueueBridge = useLatestCallback(
    (): FolioAgentBridge | null => {
      const editorBridge = createFolioAgentBridge();
      if (!editorBridge) {
        return null;
      }
      return {
        ...editorBridge,
        snapshot: () =>
          lastSentDocxEditSnapshotRef.current ?? editorBridge.snapshot(),
        applyDocumentOperations: (batch) => queueSuggestChangesBatch(batch),
      };
    },
  );

  // Latest approval-requested/responded tool-call part matching the given
  // approval id and tool name (newest message first). Used to recover the
  // streamed input of a client-executed approval tool once the user approves.
  const isFolioAgentApprovalPart = <
    TName extends FolioAgentCommentMutationToolName,
  >(
    part: unknown,
    toolName: TName,
  ): part is ApprovalToolPart & RegisteredFolioAgentToolCallPart<TName> =>
    isApprovalPart(part) && part.name === toolName && part.input !== undefined;

  const findFolioAgentApprovalPart = <
    TName extends FolioAgentCommentMutationToolName,
  >(
    approvalId: string,
    toolName: TName,
  ): (ApprovalToolPart & RegisteredFolioAgentToolCallPart<TName>) | null => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages.at(index);
      if (!message || message.role !== "assistant") {
        continue;
      }
      for (const part of message.parts) {
        if (
          isFolioAgentApprovalPart(part, toolName) &&
          part.approval.id === approvalId
        ) {
          return part;
        }
      }
    }
    return null;
  };

  const runFolioAgentCommentMutationTool = async (
    part: ApprovalToolPart &
      RegisteredFolioAgentToolCallPart<FolioAgentCommentMutationToolName>,
  ) => {
    try {
      const bridge = createFolioAgentBridge();
      const output = bridge
        ? await Promise.resolve(executeTypedFolioToolCall(part, bridge))
        : { ok: false, error: "No document is open." };
      await addToolResult({ output, tool: part.name, toolCallId: part.id });
    } catch (toolCallError) {
      getAnalytics().captureError(toolCallError);
      try {
        await addToolResult({
          output: {
            ok: false,
            error:
              toolCallError instanceof Error
                ? toolCallError.message
                : String(toolCallError),
          },
          tool: part.name,
          toolCallId: part.id,
        });
      } catch (reportError) {
        getAnalytics().captureError(reportError);
      }
    }
  };

  const approveAndRunFolioAgentCommentMutation = async ({
    approvalId,
    approve,
    toolName,
  }: {
    approvalId: string;
    approve: () => Promise<void>;
    toolName: ApprovalToolName;
  }) => {
    if (!isFolioAgentCommentMutationToolName(toolName)) {
      await approve();
      return;
    }

    const part = findFolioAgentApprovalPart(approvalId, toolName);

    await approve();
    if (!part) {
      return;
    }
    await runFolioAgentCommentMutationTool(part);
  };

  const handleApproveWithDocxUnlock = async (
    approvalId: string,
    toolName: ApprovalToolName,
  ) => {
    // folio-agents comment mutations are client-executed behind approval: once
    // the user approves, run the operation against the live editor bridge and
    // answer the tool call with its result. The auto-run tools (reads and
    // `suggest_changes`) never reach here.
    if (isFolioAgentCommentMutationToolName(toolName)) {
      await approveAndRunFolioAgentCommentMutation({
        approvalId,
        approve: async () => await handleApprove(approvalId, toolName),
        toolName,
      });
      return;
    }

    await handleApprove(approvalId, toolName);
  };

  const handleAllowInConversationWithFolioAgentCommentExecution = async (
    approvalId: string,
    toolName: ApprovalToolName,
  ) => {
    await approveAndRunFolioAgentCommentMutation({
      approvalId,
      approve: async () =>
        await handleAllowInConversation(approvalId, toolName),
      toolName,
    });
  };

  const handleAlwaysAllowWithFolioAgentCommentExecution = async (
    approvalId: string,
    toolName: ApprovalToolName,
  ) => {
    await approveAndRunFolioAgentCommentMutation({
      approvalId,
      approve: async () => await handleAlwaysAllow(approvalId, toolName),
      toolName,
    });
  };

  // Auto-run watcher for the client-executed, no-approval folio-agents tools:
  // the reads and the queue-only `suggest_changes`. Nothing else in the
  // runtime resolves these — there is no approval click to gate re-entrancy
  // the way `handleApproveWithDocxUnlock` is, so this effect tracks which
  // `toolCallId`s it has already dispatched itself. The comment MUTATION
  // tools are approval-gated and never flow through here (they are excluded
  // from `selectUnresolvedFolioAgentDocToolCallParts`).
  const executedFolioAgentDocToolCallIdsRef = useRef<Set<string> | null>(null);
  executedFolioAgentDocToolCallIdsRef.current ??= new Set<string>();
  // `suggest_changes` output is computed on the FIRST attempt per tool-call
  // id. A retry (after an `addToolResult` failure re-arms the part) must
  // re-send that exact output rather than recompute: queueing again would
  // spawn duplicate review cards / server rows for one logical call.
  const suggestChangesOutputCacheRef = useRef<Map<
    string,
    FolioToolCallResultFor<typeof SUGGEST_CHANGES_TOOL_NAME>
  > | null>(null);
  suggestChangesOutputCacheRef.current ??= new Map();
  const runFolioAgentDocToolCall = useLatestCallback(
    async (part: UnresolvedFolioAgentDocToolCallPart) => {
      try {
        if (part.name === SUGGEST_CHANGES_TOOL_NAME) {
          const outputCache = suggestChangesOutputCacheRef.current;
          let output = outputCache?.get(part.id);
          if (output === undefined) {
            const queueBridge = createReviewQueueBridge();
            output = queueBridge
              ? executeFolioToolCall(
                  SUGGEST_CHANGES_TOOL_NAME,
                  part.input,
                  queueBridge,
                  FILE_OVERLAY_TOOL_OPTIONS,
                )
              : { ok: false, error: "No document is open." };
            outputCache?.set(part.id, output);
          }
          await addToolResult({
            tool: SUGGEST_CHANGES_TOOL_NAME,
            toolCallId: part.id,
            output,
          });
          return;
        }
        // Read the ref fresh on every call rather than capturing it in a
        // memo: `docxEditorRef.current` can change identity (remount,
        // editor swap) between when this effect schedules the call and
        // when it actually runs. `read_comments` reads the host's controlled
        // comment state through the same bridge the mutation tools write.
        const bridge = createFolioAgentBridge();
        if (!bridge) {
          await addToolResult({
            tool: part.name,
            toolCallId: part.id,
            output: { ok: false, error: "No document is open." },
          });
          return;
        }

        const result = await Promise.resolve(
          executeTypedFolioToolCall(part, bridge),
        );
        await addToolResult({
          tool: part.name,
          toolCallId: part.id,
          output: result,
        });
      } catch (toolCallError) {
        // Allow a retry: a later render of the same unresolved part should
        // be dispatched again instead of hanging forever.
        executedFolioAgentDocToolCallIdsRef.current?.delete(part.id);
        getAnalytics().captureError(toolCallError);
        try {
          await addToolResult({
            tool: part.name,
            toolCallId: part.id,
            output: {
              ok: false,
              error:
                toolCallError instanceof Error
                  ? toolCallError.message
                  : String(toolCallError),
            },
          });
        } catch (reportError) {
          getAnalytics().captureError(reportError);
        }
      }
    },
  );
  // Only once the stream is idle: a client-executed call is unresolved for
  // good after the server finished the turn without answering it, whereas
  // the server-executed `suggest_changes` apply variant sits in
  // `input-complete` for a moment before its approval request arrives.
  // Acting on that transient state would queue an approval-gated batch into
  // the review panel and answer a call the server owns.
  useExternalSyncEffect(() => {
    if (isGenerating) {
      return;
    }
    const message = messages.at(-1);
    if (!message || message.role !== "assistant") {
      return;
    }

    const executedIds = executedFolioAgentDocToolCallIdsRef.current;
    if (!executedIds) {
      return;
    }

    const partsToRun = selectUnresolvedFolioAgentDocToolCallParts(
      message.parts,
      executedIds,
    );
    for (const part of partsToRun) {
      executedIds.add(part.id);
      detached(
        runFolioAgentDocToolCall(part),
        "file-chat-overlay.run-folio-agent-doc-tool-call",
      );
    }
  }, [isGenerating, messages, runFolioAgentDocToolCall]);

  const threadScrollRef = useRef<HTMLDivElement>(null);
  const hasMessages = messages.length > 0;
  const hasThreadContent = hasMessages || error !== undefined;
  // Auto-open the thread panel as soon as the first message lands so users see
  // streaming without having to click the chevron. Adjust-state-during-render on
  // the hasThreadContent transition (not every render) so the user can still
  // minimise the panel afterwards while content is present.
  // Seeded false (not hasThreadContent) so mounting with an already-hydrated
  // thread counts as a transition and auto-opens, matching the former effect.
  const [prevHasThreadContent, setPrevHasThreadContent] = useState(false);
  if (hasThreadContent !== prevHasThreadContent) {
    setPrevHasThreadContent(hasThreadContent);
    if (hasThreadContent) {
      setPanelOpen(true);
    }
  }
  // Escape collapses the open thread card (typically pressed while the
  // composer is focused). Window-level listener gated on `panelOpen`,
  // same idiom as the AI-suggestions surface's panel; the card reopens
  // automatically on the next send.
  useExternalSyncEffect(() => {
    if (!panelOpen) {
      return undefined;
    }
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setPanelOpen(false);
      }
    };
    window.addEventListener("keydown", handler);
    return () => {
      window.removeEventListener("keydown", handler);
    };
  }, [panelOpen]);
  // A draft handed over from another surface (a review finding's "Ask in
  // chat"): it lands in this file's composer, opens the thread, and is
  // acknowledged so a later mount does not replay it.
  const pendingFileChatDraft = useInspectorCommandStore(
    (state) => state.pendingFileChatDraft,
  );
  const activeFileFieldId = activeFile?.fileFieldId;
  useExternalSyncEffect(() => {
    if (
      pendingFileChatDraft === null ||
      activeFileFieldId === undefined ||
      pendingFileChatDraft.fileFieldId !== activeFileFieldId
    ) {
      return undefined;
    }
    editorController.setContent(pendingFileChatDraft.html);
    editorController.focus();
    setPanelOpen(true);
    useInspectorCommandStore
      .getState()
      .clearFileChatDraft(pendingFileChatDraft.sequence);
    return undefined;
  }, [activeFileFieldId, editorController, pendingFileChatDraft]);
  // One handler for every new-thread entry point (dock icon and the
  // `/new` reserved command): abort any live stream first — the
  // rotation remount only swaps the surface, while the old Chat
  // instance would keep streaming inside the query cache.
  const startNewThread = () => {
    if (isDraftChatFrozen()) {
      return;
    }
    stop();
    shouldFocusComposerAfterNewThreadRef.current = true;
    setPanelOpen(false);
    onNewThread(createChatThreadId());
  };
  const handleComposerSubmit = useLatestCallback(
    async ({
      prompt,
      files,
    }: {
      prompt: string;
      files: ChatDraftAttachment[];
    }) => {
      const newThreadMessages: string[] = [];
      const handledReserved = runReservedChatCommand(prompt, {
        new: (args) => {
          if (args.length > 0) {
            newThreadMessages.push(args);
            return;
          }
          startNewThread();
          editorController.setContent("");
        },
        "rename-chat": (args) => {
          editorController.setContent("");
          if (!hasMessages) {
            stellaToast.add({
              title: t("chat.renameUnavailableEmptyThread"),
              type: "info",
            });
            return;
          }
          setPanelOpen(true);
          useChatRenameCommandStore.getState().requestRename({
            threadId: threadRef.threadId,
            title: args.length > 0 ? args : null,
          });
        },
      });
      if (!handledReserved) {
        await handlePromptSubmit({ prompt, files });
        return;
      }

      const newThreadMessage = newThreadMessages.at(0);
      if (newThreadMessage === undefined) {
        return;
      }
      if (!(await ensureAIAvailable())) {
        throw new ChatSubmitPreservedError({ message: "AI is unavailable" });
      }
      if (Result.isError(await modelSelection.awaitPendingSelection())) {
        throw new ChatSubmitPreservedError({
          message: "Model selection failed",
        });
      }
      const newThreadRef: ChatThreadRef =
        workspaceId === undefined
          ? { scope: "global", threadId: createChatThreadId() }
          : {
              scope: "workspace",
              threadId: createChatThreadId(),
              workspaceId,
            };
      await startNewThreadCommandHandoff({
        activeOrganizationId,
        context: {
          ...chatThreadContext,
          getSendMode: () => getChatSendMode(newThreadRef),
        },
        files,
        html: newThreadMessage,
        queryClient,
        threadRef: newThreadRef,
      });
      stop();
      onNewThread(newThreadRef.threadId);
    },
  );
  // A new message (the user's send, or a fresh assistant turn) re-pins the
  // transcript to the bottom and jumps there, regardless of where the user had
  // scrolled.
  const stickToBottomRef = useRef(true);
  useLayoutEffect(() => {
    const el = threadScrollRef.current;
    if (!el) {
      return;
    }
    stickToBottomRef.current = true;
    el.scrollTop = el.scrollHeight;
  }, [lastMessageId, panelOpen]);
  let sendDisabledReason: "draft-saving" | "editor-loading" | undefined;
  if (draftPersistence.status === "saving") {
    sendDisabledReason = "draft-saving";
  } else if ((activeFile || activeDraft) && docxEditorRef && !editorReady) {
    sendDisabledReason = "editor-loading";
  }
  // While pinned to the bottom, follow every content growth — streaming tokens
  // during "preparation" steps, the reasoning block expanding, and the async
  // follow-up chips arriving after the answer — so the view tracks the content
  // smoothly instead of doing nothing mid-stream and then jumping at the end
  // (which left the late-loading chips stranded below the fold). Scrolling up
  // unpins; returning near the bottom re-pins, so history reading isn't yanked.
  useLayoutEffect(() => {
    const el = threadScrollRef.current;
    if (!el || !panelOpen) {
      return undefined;
    }
    const NEAR_BOTTOM_PX = 160;
    let frame = 0;
    const onScroll = () => {
      stickToBottomRef.current =
        el.scrollHeight - el.scrollTop - el.clientHeight <= NEAR_BOTTOM_PX;
    };
    const stick = () => {
      if (!stickToBottomRef.current || frame !== 0) {
        return;
      }
      frame = requestAnimationFrame(() => {
        frame = 0;
        el.scrollTop = el.scrollHeight;
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    const observer = new MutationObserver(stick);
    observer.observe(el, {
      characterData: true,
      childList: true,
      subtree: true,
    });
    return () => {
      el.removeEventListener("scroll", onScroll);
      observer.disconnect();
      if (frame !== 0) {
        cancelAnimationFrame(frame);
      }
    };
  }, [panelOpen]);

  return (
    <ChatMattersContext
      value={{
        createDocumentMatters,
        isLoadingCreateDocumentMatters,
      }}
    >
      <ChatApprovalContext
        value={{
          activeOrganizationId,
          alwaysApprovedTools,
          conversationApprovedTools,
          handleAllowInConversation:
            handleAllowInConversationWithFolioAgentCommentExecution,
          handleAlwaysAllow: handleAlwaysAllowWithFolioAgentCommentExecution,
          handleApprove: handleApproveWithDocxUnlock,
          handleDeny,
          handleRetryAfterAuthorNameSet: resendLatestMessage,
          blockedApprovalTools,
        }}
      >
        {panelOpen && hasThreadContent && (
          <ChatThreadCard
            bottomOffsetClass={
              hasPendingReview
                ? FLOATING_THREAD_CARD_OFFSET_WITH_REVIEW_CLASS
                : undefined
            }
            onCollapse={() => setPanelOpen(false)}
            scrollRef={threadScrollRef}
            titleSlot={
              <FileChatTitleSlot
                activeOrganizationId={activeOrganizationId}
                hasMessages={hasMessages}
                threadRef={threadRef}
                usedAnonymization={data.usedAnonymization}
              />
            }
          >
            <ChatThreadMessages
              activeFileName={activeFile?.fileName}
              assistantTextDensity="compact"
              approvalPendingMessageId={approvalPendingMessageId}
              error={error}
              hasOlderMessages={olderCursor !== null}
              isGenerating={isGenerating}
              isLoadingOlder={isLoadingOlder}
              loadOlderError={loadOlderError}
              messages={messages}
              onAskUserEditAndRerun={handleAskUserEditAndRerun}
              onAskUserEditingChange={handleAskUserEditingChange}
              onAskUserSubmit={handleAskUserSubmit}
              onCreateDocumentResolve={handleCreateDocumentResolve}
              onLoadOlder={loadOlder}
              onOpenCreateDocumentDraft={handleOpenCreateDocumentDraft}
              onOpenCreatedDocument={handleOpenCreatedDocument}
              onRemoveQueuedMessage={removeQueuedMessage}
              onResend={resendLatestMessage}
              queuedMessages={queuedMessages}
              scrollContainerRef={threadScrollRef}
              showThinkingIndicator
              streamdownComponents={streamdownComponents}
              workspaceId={workspaceId}
            />
            {/* Follow-up chips ride at the bottom of the transcript flow (not a
                pinned footer, which the card's `max-h`/`overflow-hidden`
                clipped): they stay inside the chat window, scroll with the
                messages, and are never smashed against the card edge. */}
            <SuggestedFollowupChips
              onSelect={(prompt) => {
                // Mirror the PromptBar send guard: when an editable DOCX's edit
                // snapshot isn't ready, block the chip send too so the model
                // never sees a follow-up without current edit context.
                if (
                  isDraftChatFrozen() ||
                  !canSubmitWithCurrentDocxSnapshot()
                ) {
                  return;
                }
                editorController.setContent(prompt);
                detached(
                  editorController.submit(async (draft) => {
                    if (!(await ensureAIAvailable())) {
                      return;
                    }
                    // Same model-race guard as the composer send path.
                    if (
                      Result.isError(
                        await modelSelection.awaitPendingSelection(),
                      )
                    ) {
                      return;
                    }
                    await sendMessage(await buildChatRequestMessage(draft));
                  }),
                  "file-chat-overlay.submit",
                );
              }}
              prompts={suggestedPrompts}
              surface="plain"
            />
          </ChatThreadCard>
        )}

        <ChatAnonymizationLayer
          editor={editorController.editor}
          enabled={anonymized}
          focused={composerFocused}
          ownerKey={getChatThreadKey(threadRef)}
          workspaceId={workspaceId ?? threadRef.threadId}
        />
        <PromptBar
          anonymized={anonymized}
          attachmentsEnabled
          attentionPulseSeq={attentionPulseSeq}
          canSubmitNow={canSubmitWithCurrentDocxSnapshot}
          context={{ activeOrganizationId, threadRef }}
          editorController={editorController}
          mcpOrganizationId={activeOrganizationId}
          models={{
            activeOrganizationId,
            threadRef,
            selectedModel: data.model,
            selectedReasoningEffort: data.reasoningEffort,
            selectModel: modelSelection.selectModel,
          }}
          reservedCommands={{ hasPersistedThread: hasMessages }}
          skillsOrganizationId={activeOrganizationId}
          emptyPlaceholder={
            filePlaceholderAction !== undefined ? (
              <span
                className={cn(
                  "text-foreground-ghost flex min-w-0 items-center gap-1.5",
                  COMPOSER_TEXT_CLASS,
                )}
              >
                <span className="shrink-0">{filePlaceholderAction}</span>
                <BidiText
                  as="span"
                  className="text-foreground-label max-w-64 truncate"
                >
                  {filePlaceholderSourceLabel}
                </BidiText>
              </span>
            ) : undefined
          }
          layout="floating"
          onFocusChange={setComposerFocused}
          onSubmitError={capturePromptSubmitError}
          minimizedThreadAction={
            !panelOpen && hasThreadContent
              ? {
                  label: t("chat.aiThread"),
                  onOpen: () => setPanelOpen(true),
                }
              : undefined
          }
          onStop={() => {
            stop();
          }}
          onSubmit={handleComposerSubmit}
          pendingCount={0}
          queueWhileGenerating
          sendDisabledReason={sendDisabledReason}
          status={isGenerating ? "generating" : "idle"}
          dock={
            <ChatComposerDock
              data={data}
              models={{
                activeOrganizationId,
                threadRef,
                selectedModel: data.model,
                selectedReasoningEffort: data.reasoningEffort,
                selectModel: modelSelection.selectModel,
              }}
              onNewThread={
                hasMessages && draftPersistence.status !== "saving"
                  ? startNewThread
                  : null
              }
              leadingContext={
                // The matter control is a real picker on every surface, so
                // the user can widen or narrow the file chat's context just
                // like the main chat and inspector. Seeded (below) with the
                // file's own matter by default. The opaque composer pill keeps
                // the input legible without adding chrome behind this row.
                contextMatterIds !== null ? (
                  <ChatMatterPicker
                    matterIds={contextMatterIds}
                    onChange={setContextMatterIds}
                  />
                ) : undefined
              }
              endExtras={
                <ComposerEditModeControl
                  onChange={setEditModeOptionId}
                  optionId={editModeOptionId}
                  selectable={canSelectEditMode}
                  unsafe={docxEditSafety === "unsafe"}
                />
              }
              threadRef={threadRef}
            />
          }
        />
      </ChatApprovalContext>
    </ChatMattersContext>
  );
};

type FileChatTitleSlotProps = {
  activeOrganizationId: string;
  hasMessages: boolean;
  threadRef: ChatThreadRef;
  usedAnonymization: boolean;
};

// Title area of the floating thread card: resolves the persisted title with
// the bounded by-id read (file threads are not guaranteed to be in the
// grouped-threads window) and mounts the shared rename affordance on it.
const FileChatTitleSlot = ({
  activeOrganizationId,
  hasMessages,
  threadRef,
  usedAnonymization,
}: FileChatTitleSlotProps) => {
  const { data: byIdTitle } = useQuery(
    chatThreadTitleOptions({
      activeOrganizationId,
      // A message-less thread has no server row yet; issuing GET /title for
      // it would produce an expected but noisy 404.
      enabled: hasMessages,
      key: {
        threadId: threadRef.threadId,
        workspaceId:
          threadRef.scope === "workspace" ? threadRef.workspaceId : undefined,
      },
    }),
  );
  const title =
    byIdTitle !== undefined && !isPlaceholderThreadTitle(byIdTitle)
      ? byIdTitle
      : "";

  return (
    <span className="flex min-w-0 items-center text-xs font-medium">
      <ChatTitleRename
        hasMessages={hasMessages}
        inputClassName="w-44 text-xs"
        ownsRenameCommand
        threadRef={threadRef}
        title={title}
        usedAnonymization={usedAnonymization}
      />
    </span>
  );
};

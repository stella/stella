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

import { Suspense, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";

import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { Result } from "better-result";
import { LoaderCircleIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import { v7 as uuidv7 } from "uuid";

import {
  createEditorRefBridge,
  executeFolioToolCall,
} from "@stll/folio-agents";
import type {
  DocxEditorRef,
  FolioAIEditOperation,
  FolioAIEditSeverity,
  FolioAIEditSnapshot,
} from "@stll/folio-react";
import { BidiText } from "@stll/ui/components/bidi-text";
import { stellaToast } from "@stll/ui/components/toast";

import { resolveDocxSuggestionRequest } from "@/components/ai-suggestions/docx-suggestion-persistence";
import {
  ChatThreadCard,
  FLOATING_THREAD_CARD_OFFSET_WITH_REVIEW_CLASS,
  PromptBar,
} from "@/components/ai-suggestions/host";
import { isNoopReviewOperation } from "@/components/ai-suggestions/review-operation-utils";
import {
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
import { useChatEditor } from "@/components/chat-editor-provider";
import type { ChatDraftAttachment } from "@/components/chat-editor-provider";
import { ChatApprovalContext } from "@/components/chat/chat-approval-context";
import { ChatComposerDock } from "@/components/chat/chat-composer-dock";
import { ComposerEditModeControl } from "@/components/chat/chat-edit-mode-selector";
import { ChatMatterPicker } from "@/components/chat/chat-matter-picker";
import { ChatMattersContext } from "@/components/chat/chat-matters-context";
import { ChatThreadMessages } from "@/components/chat/chat-thread-messages";
import {
  getActiveDocxEditApprovalPart,
  isApplyActiveDocxEditsInput,
  isApprovalPart,
  parseCompletedToolCallArguments,
  selectUnresolvedActiveDocxEditToolCallParts,
  selectUnresolvedFolioAgentDocToolCallParts,
} from "@/components/chat/chat-ui-tools";
import type {
  ApprovalToolName,
  ApprovalToolPart,
  UnresolvedActiveDocxEditToolCallPart,
  UnresolvedFolioAgentDocToolCallPart,
} from "@/components/chat/chat-ui-tools";
import { useChatModelSelection } from "@/components/chat/use-chat-model-selection";
import type { DocxComments } from "@/components/docx/app-docx-editor";
import { useAIKeyGate } from "@/components/require-ai-key";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { getTranslator } from "@/i18n/i18n-store";
import { getAnalytics } from "@/lib/analytics/provider";
import { ChatAnonymizationLayer } from "@/lib/anonymize/use-chat-anonymization-layer";
import { api } from "@/lib/api";
import {
  getChatSendMode,
  useChatAnonymized,
} from "@/lib/chat-anonymized-store";
import { useIsChatDraftEmpty } from "@/lib/chat-draft-store";
import {
  docxEditRepresentationForSelection,
  resolveActiveDocxEditModeState,
} from "@/lib/chat-edit-mode";
import {
  getChatEditModeSelection,
  useChatEditModeStore,
} from "@/lib/chat-edit-mode-store";
import type { ChatThreadId, ChatThreadRef } from "@/lib/chat-thread-ref";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import { useModelSelectorStore } from "@/lib/model-selector-store";
import { matchReservedChatCommand } from "@/lib/reserved-chat-commands";
import { toSafeId } from "@/lib/safe-id";
import { SuggestedFollowupChips } from "@/routes/_protected.chat/-components/suggested-followup-chips";
import { useChatSession } from "@/routes/_protected.chat/-hooks/use-chat-session";
import { useChatThreadRuntime } from "@/routes/_protected.chat/-hooks/use-chat-thread-runtime";
import { useChatUserContext } from "@/routes/_protected.chat/-hooks/use-chat-user-context";
import { buildChatRequestMessage } from "@/routes/_protected.chat/-lib/build-chat-request-message";
import type {
  ApplyActiveDocxEditsInput,
  ApplyActiveDocxEditsOutput,
} from "@/routes/_protected.chat/-queries";
import {
  applyChatModelChange,
  chatThreadOptions,
  chatThreadSuggestedPromptsOptions,
  fileChatThreadOptions,
} from "@/routes/_protected.chat/-queries";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";

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

const capturePromptSubmitError = (error: unknown): void => {
  getAnalytics().captureError(error);
};

type ToolInputOperation = ApplyActiveDocxEditsInput["operations"][number];

type PreparedOperation = {
  folio: FolioAIEditOperation;
  input: ToolInputOperation;
  /** Internal suggestion/operation id — always generated (uuid-based) so
   *  review-store entries stay unique across batches. */
  id: string;
  /** Id echoed to the model in `queued`/`skipped`: the model-supplied
   *  operation id when present (folio contract), else {@link id}. */
  reportId: string;
};

const getOperationComment = (
  operation: ToolInputOperation,
): { text: string } | undefined => {
  switch (operation.type) {
    case "replaceInBlock":
    case "replaceRange":
    case "insertAfterBlock":
    case "insertBeforeBlock":
    case "replaceBlock":
    case "deleteBlock":
    case "insertSignatureTable":
      return operation.comment ? { text: operation.comment.text } : undefined;
    // Table ops carry no `comment` field in the 0.12 union; never read
    // `.comment` on them.
    case "insertTableRow":
    case "deleteTableRow":
    case "insertTableColumn":
    case "deleteTableColumn":
    case "mergeTableCells":
    case "splitTableCell":
      return undefined;
    case "commentOnBlock":
    case "commentOnRange":
      return { text: operation.comment.text };
    default:
      operation satisfies never;
      return undefined;
  }
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
const PLACEHOLDER_RE = /\[\[(?<inner>[^\]]+?)\]\]/gu;
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

type PrepareOperationOptions = {
  operation: ToolInputOperation;
  id: string;
  comment: { text: string } | undefined;
};

type RangeOperationOptions = {
  operation: Extract<
    ToolInputOperation,
    { type: "commentOnRange" | "replaceRange" }
  >;
  id: string;
  comment: { text: string } | undefined;
};

// Range-addressed operations pass the `find_text` handle straight
// through; the apply engine re-validates it against the live document
// and skips with `staleRange` when the selection no longer matches.
const toFolioRangeOperation = ({
  operation,
  id,
  comment,
}: RangeOperationOptions): FolioAIEditOperation => {
  if (operation.type === "commentOnRange") {
    return {
      comment: { text: operation.comment.text },
      id,
      range: operation.range,
      type: operation.type,
    };
  }
  const next: FolioAIEditOperation = {
    id,
    range: operation.range,
    replace: operation.replace,
    type: operation.type,
  };
  if (comment) {
    next.comment = comment;
  }
  return next;
};

const toFolioOperation = ({
  operation,
  id,
  comment,
}: PrepareOperationOptions): FolioAIEditOperation | null => {
  switch (operation.type) {
    case "replaceInBlock": {
      const next: FolioAIEditOperation = {
        blockId: operation.blockId,
        find: operation.find,
        id,
        replace: operation.replace,
        type: operation.type,
      };
      if (comment) {
        next.comment = comment;
      }
      return next;
    }
    case "insertAfterBlock":
    case "insertBeforeBlock": {
      const next: FolioAIEditOperation = {
        blockId: operation.blockId,
        id,
        text: cleanDirectiveText(operation.text),
        type: operation.type,
      };
      if (operation.inheritFormatting !== undefined) {
        next.inheritFormatting = operation.inheritFormatting;
      }
      if (operation.pageBreakBefore !== undefined) {
        next.pageBreakBefore = operation.pageBreakBefore;
      }
      if (operation.styleId !== undefined) {
        next.styleId = operation.styleId;
      }
      if (comment) {
        next.comment = comment;
      }
      return next;
    }
    case "replaceBlock": {
      const cleanedText = cleanDirectiveText(operation.text);
      // Empty replacement = remove the block. The canonical op for
      // that is `deleteBlock`; normalize at the boundary so the model
      // doesn't have to pick between two operations.
      if (cleanedText.length === 0) {
        const next: FolioAIEditOperation = {
          blockId: operation.blockId,
          id,
          type: "deleteBlock",
        };
        if (comment) {
          next.comment = comment;
        }
        return next;
      }
      const next: FolioAIEditOperation = {
        blockId: operation.blockId,
        id,
        text: cleanedText,
        type: operation.type,
      };
      if (operation.preserveFormatting !== undefined) {
        next.preserveFormatting = operation.preserveFormatting;
      }
      if (operation.styleId !== undefined) {
        next.styleId = operation.styleId;
      }
      if (comment) {
        next.comment = comment;
      }
      return next;
    }
    case "insertSignatureTable": {
      const next: FolioAIEditOperation = {
        blockId: operation.blockId,
        id,
        parties: operation.parties.map((p) => ({
          name: p.name,
          ...(p.signatory !== undefined && { signatory: p.signatory }),
          ...(p.title !== undefined && { title: p.title }),
        })),
        type: operation.type,
      };
      if (operation.position !== undefined) {
        next.position = operation.position;
      }
      if (comment) {
        next.comment = comment;
      }
      return next;
    }
    case "deleteBlock": {
      const next: FolioAIEditOperation = {
        blockId: operation.blockId,
        id,
        type: operation.type,
      };
      if (comment) {
        next.comment = comment;
      }
      return next;
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
      return next;
    }
    // Table ops apply natively in folio; stella only threads the anchor
    // (`blockId`) and the op-specific fields through. Each is its own
    // member of the folio union (unlike insertAfter/insertBefore, which
    // share one), so they cannot be collapsed into a shared arm: an
    // object literal with a multi-literal `type` is not assignable to any
    // single member.
    case "insertTableRow": {
      const next: FolioAIEditOperation = {
        blockId: operation.blockId,
        id,
        type: operation.type,
      };
      if (operation.position !== undefined) {
        next.position = operation.position;
      }
      if (operation.cellTexts !== undefined) {
        next.cellTexts = operation.cellTexts;
      }
      return next;
    }
    case "insertTableColumn": {
      const next: FolioAIEditOperation = {
        blockId: operation.blockId,
        id,
        type: operation.type,
      };
      if (operation.position !== undefined) {
        next.position = operation.position;
      }
      if (operation.cellTexts !== undefined) {
        next.cellTexts = operation.cellTexts;
      }
      return next;
    }
    case "deleteTableRow":
      return { blockId: operation.blockId, id, type: operation.type };
    case "deleteTableColumn":
      return { blockId: operation.blockId, id, type: operation.type };
    case "splitTableCell":
      return { blockId: operation.blockId, id, type: operation.type };
    case "mergeTableCells": {
      // The op carries either an opposite-corner anchor (`endBlockId`)
      // or a downward span (`rowCount`); the union enforces exactly one.
      if (operation.endBlockId !== undefined) {
        return {
          blockId: operation.blockId,
          endBlockId: operation.endBlockId,
          id,
          type: operation.type,
        };
      }
      return {
        blockId: operation.blockId,
        id,
        rowCount: operation.rowCount,
        type: operation.type,
      };
    }
    case "replaceRange":
    case "commentOnRange":
      return toFolioRangeOperation({ operation, id, comment });
    default:
      operation satisfies never;
      return null;
  }
};

const prepareOperations = (
  operations: ApplyActiveDocxEditsInput["operations"],
): PreparedOperation[] => {
  const prepared: PreparedOperation[] = [];

  for (const [index, operation] of operations.entries()) {
    const id = `ai-docx-${String(index + 1)}-${uuidv7()}`;
    const comment = getOperationComment(operation);
    const folio = toFolioOperation({ operation, id, comment });
    if (folio === null) {
      continue;
    }
    prepared.push({
      folio,
      input: operation,
      id,
      reportId: operation.id ?? id,
    });
  }

  return prepared;
};

// Defensive fallbacks: persisted tool calls predate the schema
// requiring `severity`/`area`, so old stored approvals can still
// reach this code with the fields missing. Type narrowing says
// they're always present; the runtime check is for legacy data.
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
    ({ id, reportId, input, folio }) => {
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
      const base: ReviewSuggestion = {
        id,
        blockId: folioOperationBlockId(folio),
        type: folio.type,
        summary: summarizeOperation(folio),
        preview,
        severity: inputOperationSeverity(input),
        area: inputOperationArea(input),
        status: "pending",
        applyMode: null,
        revisionIds: null,
        undoHandle: null,
        pendingOperation: folio,
        snapshot,
      };
      const label = labelsById.get(folioOperationBlockId(folio));
      if (label !== undefined) {
        base.blockLabel = label;
      }
      const folioComment = folioOperationComment(folio);
      if (folioComment) {
        base.comment = folioComment.text;
      }
      return [base];
    },
  );

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

  const result = await Result.tryPromise(
    async () =>
      await api["docx-suggestions"]({ workspaceId })
        .entity({ entityId })
        .put({ suggestions, originThreadId: chatThreadId ?? null }),
  );
  if (Result.isError(result)) {
    getAnalytics().captureError(result.error);
    return;
  }
  const { data, error } = result.value;
  if (error) {
    getAnalytics().captureError(toAPIError(error));
    return;
  }
  const refToId = Object.fromEntries(
    data.items.map(({ ref, id }) => [ref, id]),
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
// edit requests on the active file (in favour of
// apply-active-docx-edits); blocking it outright robbed users of
// the legitimate "create a new document from this chat" flow.
// The folio-agents comment MUTATION tools: client-executed against the live
// editor bridge, but behind approval (unlike the auto-run read tools). After
// the user approves, the overlay executes them via `executeFolioToolCall`, the
// same shape as `apply-active-docx-edits`. Names mirror the server-side
// registration in `folio-agent-tools.ts`; kept as local literals like the
// other tool names this surface matches on.
const FOLIO_AGENT_COMMENT_MUTATION_TOOL_NAMES: readonly string[] =
  Object.freeze(["add_comment", "reply_comment", "resolve_comment"]);

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
  activeExternal?: ActiveExternal | undefined;
  docxEditorRef?: RefObject<DocxEditorRef | null> | undefined;
  docxEditable?: boolean | undefined;
  /**
   * The DOCX is unsafe for Folio to rewrite (editing blocked entirely). The
   * composer reflects this quietly as a "View only" edit-mode state rather
   * than the host toasting on every edit attempt.
   */
  docxEditUnsafe?: boolean | undefined;
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
  onNewThread: () => void;
};

const protectedRouteApi = getRouteApi("/_protected");

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
  activeExternal,
  docxEditable,
  docxEditUnsafe,
  docxEditorRef,
  docxComments,
  onDocxCommentsChange,
  onNewThread,
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
          docxComments={docxComments}
          docxEditable={docxEditable}
          docxEditUnsafe={docxEditUnsafe}
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
        activeFile={activeFile}
        chatThreadId={chatThreadId}
        docxComments={docxComments}
        docxEditable={docxEditable}
        docxEditUnsafe={docxEditUnsafe}
        docxEditorRef={docxEditorRef}
        onDocxCommentsChange={onDocxCommentsChange}
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
  docxEditUnsafe,
  docxEditorRef,
  onDocxCommentsChange,
  onNewThread,
  requestDocxEditMode,
  workspaceId,
}: ResolvedFileChatOverlayProps) => {
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { data: chatThreadId } = useSuspenseQuery(
    fileChatThreadOptions({
      activeOrganizationId,
      key: {
        entityId: activeFile.entityId,
        fieldId: activeFile.fileFieldId,
        workspaceId,
      },
      // Must match FileChatOverlayInner's own `hasDocxEditSurface` below
      // (same `docxEditorRef` prop, and `activeFile` is always defined
      // here) so the cache entry this query seeds lands under the same
      // key that overlay's chatThreadOptions lookup will use.
      hasDocxEditSurface: docxEditorRef !== undefined,
    }),
  );

  return (
    <FileChatOverlayInner
      activeFile={activeFile}
      chatThreadId={chatThreadId}
      docxComments={docxComments}
      docxEditable={docxEditable}
      docxEditUnsafe={docxEditUnsafe}
      docxEditorRef={docxEditorRef}
      onDocxCommentsChange={onDocxCommentsChange}
      onNewThread={onNewThread}
      requestDocxEditMode={requestDocxEditMode}
      workspaceId={workspaceId}
    />
  );
};

type FileChatOverlayInnerProps = Omit<FileChatOverlayProps, "chatThreadId"> & {
  chatThreadId: ChatThreadId;
};

const FileChatOverlayInner = ({
  workspaceId,
  chatThreadId,
  activeFile,
  activeExternal,
  docxEditable,
  docxEditUnsafe,
  docxEditorRef,
  docxComments,
  onDocxCommentsChange,
  onNewThread,
}: FileChatOverlayInnerProps) => {
  const t = useTranslations();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const userContext = useChatUserContext();
  const getUserContext = useLatestCallback(() => userContext);
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
  // Per-send anonymization now reads the shared per-thread store keyed by
  // `threadRef`, same as every other chat surface: the dock's shield
  // shows `useChatAnonymized(threadRef)`, the transport reads
  // `getChatSendMode(threadRef)`, and `ChatAnonymizationLayer` drives the
  // in-editor highlight cue — one source, so display and send agree.
  const anonymized = useChatAnonymized(threadRef);
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
  const lastSentDocxEditSnapshotRef = useRef<FolioAIEditSnapshot | null>(null);
  // Seeded with the shared empty constant instead of normalizing during
  // render (the initializer would rebuild and discard the value every
  // render); the layout effect below fills it before anything reads it.
  const latestDocxCommentsRef = useRef<DocxComments>(EMPTY_DOCX_COMMENTS);
  useLayoutEffect(() => {
    latestDocxCommentsRef.current = normalizeDocxComments(docxComments);
  }, [docxComments]);
  const hasDocxEditSurface =
    activeFile !== undefined && docxEditorRef !== undefined;
  // Whether the floating DOCX `ReviewBar` is showing for this entity — it
  // renders while any suggestion is pending/applying (mirrors the bar's own
  // `isPending` gate). When it is, the thread card lifts above the bar so the
  // two floating surfaces never overlap.
  const reviewEntityId = activeFile?.entityId;
  const hasPendingReview = useReviewStore((state) => {
    if (reviewEntityId === undefined) {
      return false;
    }
    const session = state.sessions[reviewEntityId];
    return (
      session !== undefined &&
      session.some(
        (item) => item.status === "pending" || item.status === "applying",
      )
    );
  });
  const editModeOptionId = useChatEditModeStore((state) => state.optionId);
  const setEditModeOptionId = useChatEditModeStore(
    (state) => state.setOptionId,
  );
  const activeDocxEditModeState = resolveActiveDocxEditModeState({
    activeFileEditable: activeFile?.editable,
    docxEditable,
    hasDocxEditSurface,
    unsafe: docxEditUnsafe === true,
    selection: getChatEditModeSelection(),
  });
  const getLatestActiveDocxEditSelection = useLatestCallback(() => {
    const state = resolveActiveDocxEditModeState({
      activeFileEditable: activeFile?.editable,
      docxEditable,
      hasDocxEditSurface,
      unsafe: docxEditUnsafe === true,
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
  // eslint-disable-next-line react/react-compiler -- mount-time seed of readiness from the imperative Folio editor instance so a transition-induced remount of an already-ready editor starts ready; the ref read runs once in the useState initializer
  const [editorReady, setEditorReady] = useState(() =>
    Boolean(docxEditorRef?.current?.createAIEditSnapshot()),
  );
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
  const activeDocumentKey =
    activeFile === undefined
      ? undefined
      : `${activeFile.entityId}:${activeFile.fileFieldId ?? ""}`;
  const [readyForDocumentKey, setReadyForDocumentKey] =
    useState(activeDocumentKey);
  if (activeDocumentKey !== readyForDocumentKey) {
    setReadyForDocumentKey(activeDocumentKey);
    setEditorReady(false);
  }
  useExternalSyncEffect(() => {
    if (editorReady || !hasDocxEditSurface) {
      return undefined;
    }
    const ensure = () =>
      docxEditorRef.current?.ensureEditorView({ focus: false });
    ensure();
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
      // Re-call ensure on each tick: when the surrounding tree is in
      // a concurrent transition (e.g. right after the "new chat" swap),
      // the first ensure can be coalesced away by React's batching.
      // The state setter is a no-op once the view is already created.
      ensure();
      if (probe()) {
        window.clearInterval(id);
      }
    }, 80);
    // Safety net: never leave the chat input gated indefinitely. If the probe
    // hasn't succeeded after a few seconds (e.g. an edge case where the
    // virtualised paged editor hasn't surfaced a non-empty doc to
    // `createAIEditSnapshot` yet), unlock the input anyway —
    // `canSubmitWithCurrentDocxSnapshot` runs at submit time and re-checks
    // the snapshot, so a stale unlock can't send unanchored edits.
    const fallbackTimer = window.setTimeout(() => {
      window.clearInterval(id);
      setEditorReady(true);
    }, 3000);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(fallbackTimer);
    };
  }, [editorReady, hasDocxEditSurface, docxEditorRef]);

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
        blocks: snapshot.blocks,
        canApplyEdits: Boolean(docxEditable),
      },
      supportsDocxEdits: true,
    };
  });
  const getActiveExternal = useLatestCallback(() => activeExternal);
  const handleActiveDocxEditToolCall = useLatestCallback(
    (input: ApplyActiveDocxEditsInput): ApplyActiveDocxEditsOutput => {
      // All edit batches — single direct edits and structured
      // reviews alike — are queued for the user. The editor is not
      // touched here; the user reviews each suggestion in the
      // panel and the unlock prompt only fires when the user
      // actually clicks Accept.
      if (!activeFile) {
        return {
          version: 1,
          applied: [],
          queued: [],
          skipped: input.operations.map((operation, index) => ({
            id: operation.id ?? `ai-docx-${String(index + 1)}`,
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
      const { queuedIds, skipped, items } = queueReviewSuggestions({
        entityId: activeFile.entityId,
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
          "FileChatOverlayInner",
        );
      }
      return {
        version: 1,
        applied: [],
        queued: queuedIds.map((id) => ({ id })),
        skipped,
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
    ...(activeFile ? { getActiveFile: () => getActiveFile() } : {}),
    ...(hasDocxEditSurface
      ? {
          handleActiveDocxEditToolCall: (input: ApplyActiveDocxEditsInput) =>
            handleActiveDocxEditToolCall(input),
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
  const queryClient = useQueryClient();
  // Persists the composer (+) menu's Models submenu selection into this
  // thread's cache, mirroring `ChatThreadPage`'s wiring so the file-chat (+)
  // menu keeps the same functionality as the main chat's.
  const modelSelection = useChatModelSelection({
    onPersisted: (model) => {
      applyChatModelChange({
        model,
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
    alwaysApprovedTools,
    conversationApprovedTools,
    handleApprove,
    handleAllowInConversation,
    handleDeny,
    handleAskUserSubmit,
    handleAskUserEditAndRerun,
    handleAlwaysAllow,
    handleCreateDocumentResolve,
    handleOpenCreatedDocument,
    createDocumentMatters,
    isLoadingCreateDocumentMatters,
    addToolResult,
    streamdownComponents,
    approvalPendingMessageId,
  } = useChatSession({
    chat,
    conversationId: threadRef.threadId,
    getDocxEditRepresentation,
    getEditApplyMode,
    getSendMode,
    initialOlderCursor: data.olderCursor,
    threadRef,
    workspaceId,
  });
  const { ensureAIAvailable, openIfAIUnavailable } = useAIKeyGate();
  const [panelOpen, setPanelOpen] = useState(false);
  const handlePromptSubmit = useLatestCallback(
    async ({
      prompt,
      files,
    }: {
      prompt: string;
      files: ChatDraftAttachment[];
    }) => {
      try {
        if (!(await ensureAIAvailable())) {
          return;
        }
        // Don't let a model just chosen from the (+) Models submenu race the
        // send: wait for its PATCH to settle (already toasted on failure) and
        // abort so the request can't run against the previous thread model.
        if (Result.isError(await modelSelection.awaitPendingSelection())) {
          return;
        }

        // Always pop the thread open on send, even if the user
        // minimised it earlier — they're sending a new prompt
        // and want to see the response stream in.
        setPanelOpen(true);
        await sendMessage(
          await buildChatRequestMessage({ files, html: prompt }),
        );
      } catch (submitError) {
        capturePromptSubmitError(submitError);
      }
    },
  );

  useExternalSyncEffect(() => {
    openIfAIUnavailable();
  }, [openIfAIUnavailable]);

  let filePlaceholder: string | undefined;
  let filePlaceholderAction: string | undefined;
  if (activeFile === undefined) {
    if (activeExternal) {
      filePlaceholder = t("chat.externalSourcePlaceholder", {
        title: activeExternal.title,
      });
      filePlaceholderAction = t("chat.externalSourcePlaceholderAction");
    }
  } else {
    // Only offer "…or edit" when the file can actually be edited: editable in
    // principle AND not blocked as unsafe-to-rewrite (view only). Otherwise the
    // placeholder promises an edit the user can't make.
    const canOfferEdit =
      activeFile.editable === true && docxEditUnsafe !== true;
    filePlaceholder = t(
      canOfferEdit ? "chat.editableFilePlaceholder" : "chat.filePlaceholder",
      { fileName: activeFile.fileName },
    );
    filePlaceholderAction = t(
      canOfferEdit
        ? "chat.editableFilePlaceholderAction"
        : "chat.filePlaceholderAction",
    );
  }

  // Check eligibility for suggested prompts using draft state (avoids
  // unnecessary API calls when user is typing).
  const lastMessageId = messages.at(-1)?.id ?? null;
  const lastMessageRole = messages.at(-1)?.role ?? null;
  const editorIsInitiallyEmpty = useIsChatDraftEmpty(threadRef);
  const eligibleForSuggestions =
    editorIsInitiallyEmpty &&
    !isGenerating &&
    lastMessageId !== null &&
    lastMessageRole === "assistant";
  const { data: suggestedPromptsData } = useQuery(
    chatThreadSuggestedPromptsOptions({
      activeOrganizationId,
      enabled: eligibleForSuggestions,
      lastMessageId: lastMessageId ?? "",
      threadRef,
    }),
  );
  const suggestedPrompts = suggestedPromptsData
    ? suggestedPromptsData.prompts
    : [];
  const suggestedFollowupPrompt = suggestedPrompts.at(0) ?? undefined;

  const editorController = useChatEditor({
    placeholder: filePlaceholder,
    reservedCommands: true,
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

  // Latest approval-requested/responded tool-call part matching the given
  // approval id and tool name (newest message first). Used to recover the
  // streamed input of a client-executed approval tool once the user approves.
  const findFolioAgentApprovalPart = (
    approvalId: string,
    toolName: string,
  ): ApprovalToolPart | null => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages.at(index);
      if (!message || message.role !== "assistant") {
        continue;
      }
      for (const part of message.parts) {
        if (
          isApprovalPart(part) &&
          part.name === toolName &&
          part.approval.id === approvalId
        ) {
          return part;
        }
      }
    }
    return null;
  };

  const runFolioAgentCommentMutationTool = async (part: ApprovalToolPart) => {
    try {
      const bridge = createFolioAgentBridge();
      const args = parseCompletedToolCallArguments(part) ?? {};
      const output = bridge
        ? await Promise.resolve(executeFolioToolCall(part.name, args, bridge))
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
    if (!FOLIO_AGENT_COMMENT_MUTATION_TOOL_NAMES.includes(toolName)) {
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
    if (toolName === "apply-active-docx-edits") {
      const part = getActiveDocxEditApprovalPart(messages, approvalId);
      if (!part) {
        await handleApprove(approvalId, toolName);
        return;
      }

      // DOCX edits no longer apply at approval time. We approve
      // the tool call (so the LLM proceeds), queue the operations
      // into the review panel via the tool call handler, and
      // surface the queued ids back to the LLM. The actual apply
      // (including the unlock prompt) happens when the user clicks
      // Accept on a suggestion in the panel.
      await handleApprove(approvalId, toolName);
      const output = handleActiveDocxEditToolCall(part.input);
      await addToolResult({
        output,
        tool: "apply-active-docx-edits",
        toolCallId: part.id,
      });
      return;
    }

    // folio-agents comment mutations are client-executed behind approval: once
    // the user approves, run the operation against the live editor bridge and
    // answer the tool call with its result (same shape as apply-active-docx-
    // edits). The read tools never reach here — they are auto-run, no approval.
    if (FOLIO_AGENT_COMMENT_MUTATION_TOOL_NAMES.includes(toolName)) {
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

  // Auto-run watcher for the client-executed, no-approval folio-agents read
  // tools (`read_document` / `find_text` / `read_changes` / `read_comments`).
  // Nothing else in the runtime resolves these — there is no approval click to
  // gate re-entrancy the way `handleApproveWithDocxUnlock` is, so this effect
  // tracks which `toolCallId`s it has already dispatched itself. The comment
  // MUTATION tools are approval-gated and never flow through here (they are
  // excluded from `selectUnresolvedFolioAgentDocToolCallParts`).
  const executedFolioAgentDocToolCallIdsRef = useRef<Set<string> | null>(null);
  executedFolioAgentDocToolCallIdsRef.current ??= new Set<string>();
  const runFolioAgentDocToolCall = useLatestCallback(
    async (part: UnresolvedFolioAgentDocToolCallPart) => {
      try {
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

        const args = parseCompletedToolCallArguments(part) ?? {};
        const result = await Promise.resolve(
          executeFolioToolCall(part.name, args, bridge),
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
  useExternalSyncEffect(() => {
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
      detached(runFolioAgentDocToolCall(part), "FileChatOverlayInner");
    }
  }, [messages, runFolioAgentDocToolCall]);

  // Auto-run watcher for the queue-only `apply-active-docx-edits` tool.
  // It carries no approval gate (it never writes to the document — it
  // only queues suggestions into the review panel), so nothing else
  // resolves it; this effect queues the operations via the tool-call
  // handler and answers the call with the queued ids, exactly what the
  // old approval branch did on approve. Tracks dispatched `toolCallId`s
  // in a ref so a re-render can't double-run the same call.
  const executedActiveDocxEditToolCallIdsRef = useRef<Set<string> | null>(null);
  executedActiveDocxEditToolCallIdsRef.current ??= new Set<string>();
  // Output computed on the FIRST attempt per tool-call id. A retry (after an
  // `addToolResult` failure re-arms the part) must re-send this exact output
  // rather than recompute: `handleActiveDocxEditToolCall` mints fresh uuids
  // and re-queues + re-persists the suggestions, so recomputing would spawn
  // duplicate review cards / server rows for one logical tool call.
  const activeDocxEditOutputCacheRef = useRef<Map<
    string,
    ApplyActiveDocxEditsOutput
  > | null>(null);
  activeDocxEditOutputCacheRef.current ??= new Map<
    string,
    ApplyActiveDocxEditsOutput
  >();
  const runActiveDocxEditToolCall = useLatestCallback(
    async (part: UnresolvedActiveDocxEditToolCallPart) => {
      const outputCache = activeDocxEditOutputCacheRef.current;
      try {
        // Compute (and queue + persist, inside the handler) only once; reuse
        // the cached output on any retry.
        let output = outputCache?.get(part.id);
        if (output === undefined) {
          const input = parseCompletedToolCallArguments(part);
          output = isApplyActiveDocxEditsInput(input)
            ? handleActiveDocxEditToolCall(input)
            : { version: 1 as const, applied: [], queued: [], skipped: [] };
          outputCache?.set(part.id, output);
        }
        await addToolResult({
          output,
          tool: "apply-active-docx-edits",
          toolCallId: part.id,
        });
      } catch (toolCallError) {
        // Allow a retry on a later render of the same unresolved part. The
        // cached output above keeps that retry from re-queuing / re-persisting.
        executedActiveDocxEditToolCallIdsRef.current?.delete(part.id);
        getAnalytics().captureError(toolCallError);
        try {
          await addToolResult({
            output: {
              version: 1 as const,
              applied: [],
              queued: [],
              skipped: [],
            },
            tool: "apply-active-docx-edits",
            toolCallId: part.id,
          });
        } catch (reportError) {
          getAnalytics().captureError(reportError);
        }
      }
    },
  );
  useExternalSyncEffect(() => {
    const message = messages.at(-1);
    if (!message || message.role !== "assistant") {
      return;
    }

    const executedIds = executedActiveDocxEditToolCallIdsRef.current;
    if (!executedIds) {
      return;
    }

    const partsToRun = selectUnresolvedActiveDocxEditToolCallParts(
      message.parts,
      executedIds,
    );
    for (const part of partsToRun) {
      executedIds.add(part.id);
      detached(runActiveDocxEditToolCall(part), "FileChatOverlayInner");
    }
  }, [messages, runActiveDocxEditToolCall]);

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
  // One handler for every new-thread entry point (dock icon and the
  // `/new` reserved command): abort any live stream first — the
  // rotation remount only swaps the surface, while the old Chat
  // instance would keep streaming inside the query cache.
  const startNewThread = () => {
    stop();
    shouldFocusComposerAfterNewThreadRef.current = true;
    setPanelOpen(false);
    onNewThread();
  };
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
  // While pinned to the bottom, follow every content growth — streaming tokens
  // during "preparation" steps, the reasoning block expanding, and the async
  // follow-up chips arriving after the answer — so the view tracks the content
  // smoothly instead of doing nothing mid-stream and then jumping at the end
  // (which left the late-loading chips stranded below the fold). Scrolling up
  // unpins; returning near the bottom re-pins, so history reading isn't yanked.
  useLayoutEffect(() => {
    const el = threadScrollRef.current;
    if (!el || !panelOpen) {
      return;
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
          >
            <ChatThreadMessages
              activeFileName={activeFile?.fileName}
              approvalPendingMessageId={approvalPendingMessageId}
              error={error}
              hasOlderMessages={olderCursor !== null}
              isGenerating={isGenerating}
              isLoadingOlder={isLoadingOlder}
              loadOlderError={loadOlderError}
              messages={messages}
              onAskUserEditAndRerun={handleAskUserEditAndRerun}
              onAskUserSubmit={handleAskUserSubmit}
              onCreateDocumentResolve={handleCreateDocumentResolve}
              onLoadOlder={loadOlder}
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
              isGenerating={isGenerating}
              isEmpty={
                editorController.isEmpty &&
                editorController.attachments.length === 0
              }
              lastMessageId={messages.at(-1)?.id ?? null}
              lastMessageRole={messages.at(-1)?.role ?? null}
              messageCount={messages.length}
              prompts={suggestedPrompts}
              surface="plain"
              onSelect={(prompt) => {
                // Mirror the PromptBar send guard: when an editable DOCX's edit
                // snapshot isn't ready, block the chip send too so the model
                // never sees a follow-up without current edit context.
                if (!canSubmitWithCurrentDocxSnapshot()) {
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
                  "FileChatOverlayInner",
                );
              }}
            />
          </ChatThreadCard>
        )}

        <ChatAnonymizationLayer
          editor={editorController.editor}
          enabled={anonymized}
          workspaceId={workspaceId ?? threadRef.threadId}
        />
        <PromptBar
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
            selectModel: modelSelection.selectModel,
          }}
          skillsOrganizationId={activeOrganizationId}
          emptyPlaceholder={
            (activeFile || activeExternal) && filePlaceholderAction ? (
              <span className="text-foreground-ghost flex min-w-0 items-center gap-1.5 text-[13px] leading-5">
                <span className="shrink-0">{filePlaceholderAction}</span>
                <BidiText
                  as="span"
                  className="text-foreground-label max-w-64 truncate"
                >
                  {activeFile?.fileName ?? activeExternal?.title}
                </BidiText>
              </span>
            ) : undefined
          }
          layout="floating"
          onStop={() => {
            stop();
          }}
          onSubmit={({ prompt, files }) => {
            const reservedCommand = matchReservedChatCommand(prompt);
            if (reservedCommand?.id === "new") {
              startNewThread();
              editorController.setContent("");
              return;
            }
            if (reservedCommand?.id === "model") {
              editorController.setContent("");
              useModelSelectorStore.getState().open();
              return;
            }

            detached(
              handlePromptSubmit({ prompt, files }),
              "FileChatOverlayInner",
            );
          }}
          pendingCount={0}
          queueWhileGenerating
          sendDisabledReason={
            activeFile && docxEditorRef && !editorReady
              ? "editor-loading"
              : undefined
          }
          status={isGenerating ? "generating" : "idle"}
          dock={
            <ChatComposerDock
              data={data}
              onNewThread={hasMessages ? startNewThread : null}
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
                  unsafe={docxEditUnsafe === true}
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

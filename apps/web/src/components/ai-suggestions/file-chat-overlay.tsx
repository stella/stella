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
import { getRouteApi } from "@tanstack/react-router";
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
import { ChatApprovalContext } from "@/components/chat/chat-approval-context";
import { ChatMattersContext } from "@/components/chat/chat-matters-context";
import { ChatThreadMessages } from "@/components/chat/chat-thread-messages";
import type {
  ActiveDocxEditApprovalPart,
  ApprovalToolName,
  PersistedChatMessage,
} from "@/components/chat/chat-ui-tools";
import { useAIKeyGate } from "@/components/require-ai-key";
import { ChatAnonymizationLayer } from "@/lib/anonymize/use-chat-anonymization-layer";
import type { ChatThreadId, ChatThreadRef } from "@/lib/chat-thread-ref";
import { useDevStore } from "@/lib/dev-store";
import { useChatSession } from "@/routes/_protected.chat/-hooks/use-chat-session";
import { useChatUserContext } from "@/routes/_protected.chat/-hooks/use-chat-user-context";
import type {
  ApplyActiveDocxEditsInput,
  ApplyActiveDocxEditsOutput,
} from "@/routes/_protected.chat/-queries";
import {
  chatThreadOptions,
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

type ToolInputOperation = ApplyActiveDocxEditsInput["operations"][number];

const summarizeOperation = (operation: ToolInputOperation): string => {
  switch (operation.type) {
    case "replaceInBlock":
      return `Replace “${operation.find}” with “${operation.replace}”`;
    case "replaceBlock":
      return `Replace block ${operation.blockId}`;
    case "insertAfterBlock":
    case "insertBeforeBlock": {
      const direction =
        operation.type === "insertAfterBlock" ? "after" : "before";
      if (operation.pageBreakBefore === true && operation.text.length === 0) {
        return `Insert page break ${direction} ${operation.blockId}`;
      }
      if (operation.styleId !== undefined) {
        return `Insert ${operation.styleId} ${direction} ${operation.blockId}: ${operation.text}`;
      }
      return `Insert ${direction} ${operation.blockId}: ${operation.text}`;
    }
    case "deleteBlock":
      return `Delete block ${operation.blockId}`;
    case "commentOnBlock":
      return `Comment on ${operation.blockId}`;
    case "insertSignatureTable": {
      const names = operation.parties.map((p) => p.name).join(", ");
      return `Insert signature table for ${names}`;
    }
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

const getOperationComment = (
  operation: ToolInputOperation,
): { text: string } | undefined => {
  switch (operation.type) {
    case "replaceInBlock":
    case "insertAfterBlock":
    case "insertBeforeBlock":
    case "replaceBlock":
    case "deleteBlock":
    case "insertSignatureTable":
      return operation.comment ? { text: operation.comment.text } : undefined;
    case "commentOnBlock":
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
const DIRECTIVE_NAMES = new Set([
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
// oxlint-disable-next-line sonarjs/slow-regex -- input is single-line paragraph text; linear backtracking only
const PLACEHOLDER_RE = /\[\[([^\]]+?)\]\]/gu;
const CLAUSE_HEADING_RE = /^@clause +\d+ *"([^"]*)" *$/iu;
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
  if (!DIRECTIVE_NAMES.has(directive)) {
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
      return clauseMatch[1] ?? "";
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
    prepared.push({ folio, input: operation, id });
  }

  return prepared;
};

// Defensive fallbacks: persisted tool calls predate the schema
// requiring `severity`/`area`, so old stored approvals can still
// reach this code with the fields missing. Type narrowing says
// they're always present; the runtime check is for legacy data.
/* oxlint-disable typescript/no-unnecessary-condition */
const inputOperationSeverity = (
  operation: ToolInputOperation,
): FolioAIEditSeverity | "unspecified" => operation.severity ?? "unspecified";

const inputOperationArea = (operation: ToolInputOperation): string =>
  operation.area ?? REVIEW_UNSPECIFIED_AREA;
/* oxlint-enable typescript/no-unnecessary-condition */

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
    case "insertSignatureTable":
      return {
        type: "insertSignatureTable",
        anchor: blockText.slice(0, PREVIEW_ANCHOR_CHARS),
        parties: operation.parties.map((p) => ({
          name: p.name,
          ...(p.signatory !== undefined && { signatory: p.signatory }),
          ...(p.title !== undefined && { title: p.title }),
        })),
        position: operation.position ?? "after",
        ...(block?.previewRuns !== undefined && {
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
  const queuedIds: string[] = [];
  const skipped: { id: string; reason: "noopOperation" | "missingBlock" }[] =
    [];
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
      skipped.push({ id, reason: "noopOperation" });
      return [];
    }
    const preview = buildPreview(input, blocksById);
    if (!preview) {
      skipped.push({ id, reason: "missingBlock" });
      return [];
    }
    queuedIds.push(id);
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

  return { queuedIds, skipped };
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
  requestDocxEditMode?: (() => boolean | Promise<boolean>) | undefined;
  /**
   * Invoked when the user explicitly starts a new thread from the
   * overlay UI. Owners should swap the `chatThreadId` they pass in
   * for a fresh value.
   */
  onNewThread: () => void;
};

const protectedRouteApi = getRouteApi("/_protected");

export const FileChatOverlay = ({
  workspaceId,
  chatThreadId,
  activeFile,
  activeExternal,
  docxEditable,
  docxEditorRef,
  onNewThread,
  requestDocxEditMode,
}: FileChatOverlayProps) => {
  const fallback = (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-x-0 bottom-8 flex justify-center"
    >
      <LoaderCircleIcon className="text-muted-foreground size-4 animate-spin" />
    </div>
  );

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
          docxEditable={docxEditable}
          docxEditorRef={docxEditorRef}
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
        docxEditable={docxEditable}
        docxEditorRef={docxEditorRef}
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
  docxEditable,
  docxEditorRef,
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
    }),
  );

  return (
    <FileChatOverlayInner
      activeFile={activeFile}
      chatThreadId={chatThreadId}
      docxEditable={docxEditable}
      docxEditorRef={docxEditorRef}
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
  docxEditorRef,
  onNewThread,
}: FileChatOverlayInnerProps) => {
  const t = useTranslations();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
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
  // Initialize from the ref so a transition-induced remount of an
  // already-ready editor starts ready (without this, useTransition's
  // Suspense swap unmounts + remounts this subtree with fresh state,
  // and the poller racing with a second rerender can leave the gate
  // stuck closed even though the underlying view is live).
  const [editorReady, setEditorReady] = useState(() =>
    Boolean(docxEditorRef?.current?.createAIEditSnapshot()),
  );
  useEffect(() => {
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
    const fallback = window.setTimeout(() => {
      window.clearInterval(id);
      setEditorReady(true);
    }, 3000);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(fallback);
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
      const { queuedIds, skipped } = queueReviewSuggestions({
        entityId: activeFile.entityId,
        prepared,
        snapshotBlocks: lastSnapshot?.blocks ?? [],
        snapshot: lastSnapshot,
      });
      return {
        applied: [],
        queued: queuedIds.map((id) => ({ id })),
        skipped,
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
      activeOrganizationId,
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
    addToolOutput,
    streamdownComponents,
    approvalPendingMessageId,
  } = useChatSession({ chat, conversationId: threadRef.threadId, workspaceId });
  const { ensureAIAvailable, openIfAIUnavailable } = useAIKeyGate();

  useEffect(() => {
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
    filePlaceholder = t(
      activeFile.editable
        ? "chat.editableFilePlaceholder"
        : "chat.filePlaceholder",
      { fileName: activeFile.fileName },
    );
    filePlaceholderAction = t(
      activeFile.editable
        ? "chat.editableFilePlaceholderAction"
        : "chat.filePlaceholderAction",
    );
  }

  const editorController = useChatEditor({
    placeholder: filePlaceholder,
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
  useEffect(() => {
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
          handleAllowInConversation,
          handleAlwaysAllow,
          handleApprove: handleApproveWithDocxUnlock,
          handleDeny,
          blockedApprovalTools,
        }}
      >
        {panelOpen && hasThreadContent && (
          <div
            aria-label={t("chat.aiThread")}
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
                approvalPendingMessageId={approvalPendingMessageId}
                error={error}
                isGenerating={isGenerating}
                messages={messages}
                onAskUserEditAndRerun={handleAskUserEditAndRerun}
                onAskUserSubmit={handleAskUserSubmit}
                onCreateDocumentResolve={handleCreateDocumentResolve}
                onOpenCreatedDocument={handleOpenCreatedDocument}
                onRemoveQueuedMessage={removeQueuedMessage}
                onResend={resendLatestMessage}
                queuedMessages={queuedMessages}
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
            shouldFocusComposerAfterNewThreadRef.current = true;
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
              return;
            });
          }}
          onTogglePanel={() => setPanelOpen((v) => !v)}
          panelOpen={panelOpen}
          pendingCount={0}
          queueWhileGenerating
          sendDisabledReason={
            activeFile && docxEditorRef && !editorReady
              ? "editor-loading"
              : undefined
          }
          showThreadToggle={hasThreadContent}
          status={isGenerating ? "generating" : "idle"}
        />
      </ChatApprovalContext>
    </ChatMattersContext>
  );
};

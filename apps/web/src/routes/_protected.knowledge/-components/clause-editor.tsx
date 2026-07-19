import { useCallback, useRef, useState } from "react";

import Bold from "@tiptap/extension-bold";
import Document from "@tiptap/extension-document";
import Heading from "@tiptap/extension-heading";
import History from "@tiptap/extension-history";
import Italic from "@tiptap/extension-italic";
import {
  BulletList,
  ListItem,
  ListKeymap,
  OrderedList,
} from "@tiptap/extension-list";
import Paragraph from "@tiptap/extension-paragraph";
import Placeholder from "@tiptap/extension-placeholder";
import Text from "@tiptap/extension-text";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import {
  BoldIcon,
  CheckIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ItalicIcon,
  ListIcon,
  ListOrderedIcon,
  Loader2Icon,
  Redo2Icon,
  RotateCcwIcon,
  Undo2Icon,
  WandSparklesIcon,
  XIcon,
} from "lucide-react";
import type { Command as PMCommand } from "prosemirror-state";
import { useTranslations } from "use-intl";

import {
  acceptAIEditRevision,
  acceptAllChanges,
  rejectAIEditRevision,
  rejectAllChanges,
} from "@stll/folio-core/prosemirror/commands/comments";
import { Button } from "@stll/ui/components/button";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors/user-safe";

import {
  buildTrackedChangeDoc,
  type ClauseEditorReviewStatus,
  hasAlignedClauseStructure,
  nonHistoricalDispatch,
  reviewResolutionStatus,
  settleReviewPersist,
} from "./clause-ai-tracked-changes";
import { ClauseDirectiveNode } from "./clause-directive-extension";
import { clauseBodyToTipTap, tipTapToClauseBody } from "./clause-editor-tiptap";
import "./clause-editor.css";
import type { ClauseBody, ClauseParagraph } from "./clause-editor-types";
import {
  DELETION_MARK,
  DeletionMark,
  INSERTION_MARK,
  InsertionMark,
} from "./clause-tracked-change-marks";

const isUsableEditor = (editor: Editor | null | undefined): editor is Editor =>
  editor !== null && editor !== undefined && !editor.isDestroyed;

const hasPendingTrackedChanges = (editor: Editor): boolean => {
  const { doc, schema } = editor.state;
  const insertionMark = schema.marks[INSERTION_MARK];
  const deletionMark = schema.marks[DELETION_MARK];

  return (
    (insertionMark !== undefined &&
      doc.rangeHasMark(0, doc.content.size, insertionMark)) ||
    (deletionMark !== undefined &&
      doc.rangeHasMark(0, doc.content.size, deletionMark))
  );
};

/** Stable identity of a body for detecting external resets vs. the editor's
 *  own round-tripped edits (text + formatting + directive kind/expression). */
const bodyKey = (body: readonly ClauseParagraph[]): string =>
  body
    .map((p) =>
      p.isDirective
        ? `D:${p.directiveKind ?? ""}:${p.directiveExpression ?? ""}`
        : `P:${p.style ?? ""}:${p.level ?? ""}:${p.listKind ?? ""}:${p.listLevel ?? ""}:${(
            p.runs ?? [{ text: p.text }]
          )
            .map((r) => `${r.bold ? "b" : ""}${r.italic ? "i" : ""}|${r.text}`)
            .join("\u0001")}`,
    )
    .join("\u0000");

// ── Editor Component ────────────────────────────────

type AiEditState =
  | { status: "idle" }
  | { status: "prompting"; instruction: string }
  | { status: "generating"; instruction: string; baseline: ClauseBody }
  | { status: "reviewing"; instruction: string; baseline: ClauseBody };

export type { ClauseEditorReviewStatus } from "./clause-ai-tracked-changes";

type ClauseEditorProps = {
  content: ClauseParagraph[];
  onChange: (body: ClauseParagraph[]) => void;
  placeholder?: string;
  /** Fired when the editor loses focus, carrying the current body. */
  onBlur?: (body: ClauseParagraph[]) => void;
  /** Context passed to the AI refine assist (current, possibly unsaved values). */
  usageNotes?: string | undefined;
  title?: string;
  onReviewStatusChange?: (status: ClauseEditorReviewStatus) => void;
  /**
   * Fired once an AI review resolves (accept/reject) with a changed body,
   * so the caller can persist it immediately instead of waiting on the
   * normal keystroke debounce. Must resolve even when the persist fails
   * (surface the error yourself, don't reject) — a failure must NOT report
   * the "persisting" gate as "resolved" via `onReviewStatusChange`; report
   * "resolved" yourself only once the body actually reaches the server,
   * whether that's this call's own success or a later retry through the
   * normal autosave path.
   */
  onReviewResolved?: (body: ClauseParagraph[]) => Promise<void>;
};

export const ClauseEditor = ({
  content,
  onChange,
  placeholder,
  onBlur,
  usageNotes,
  title,
  onReviewStatusChange,
  onReviewResolved,
}: ClauseEditorProps) => {
  const t = useTranslations();
  const [aiEdit, setAiEdit] = useState<AiEditState>({ status: "idle" });
  const [hunkMenu, setHunkMenu] = useState<{
    revisionId: number;
    top: number;
    left: number;
  } | null>(null);

  const getAiState = useLatestCallback(() => aiEdit);
  const getContent = useLatestCallback(() => content);
  const emitChange = useLatestCallback(onChange);
  const emitBlur = useLatestCallback((body: ClauseParagraph[]) =>
    onBlur?.(body),
  );
  const emitReviewStatus = useLatestCallback(
    (status: ClauseEditorReviewStatus) => onReviewStatusChange?.(status),
  );
  const emitReviewResolved = useLatestCallback(
    async (body: ClauseParagraph[]) => {
      await onReviewResolved?.(body);
    },
  );
  const hasReviewResolvedHandler = useLatestCallback(
    () => onReviewResolved !== undefined,
  );

  const updateInstruction = (value: string) => {
    setAiEdit((prev) => {
      if (prev.status === "prompting") {
        return { status: "prompting", instruction: value };
      }
      if (prev.status === "reviewing") {
        return { ...prev, instruction: value };
      }
      return prev;
    });
  };

  // Last body the editor itself emitted, so the reset effect can tell an
  // external content change (dialog reset, clause switch) from the round-trip
  // of the user's own keystroke and avoid clobbering the cursor.
  const lastEmittedKeyRef = useRef(bodyKey(content));
  const containerRef = useRef<HTMLDivElement>(null);
  const rewriteRequestIdRef = useRef(0);

  const editor = useEditor({
    // Inline on an SSR'd page (unlike the old modal, which only mounted
    // client-side): defer editor creation to the client so the server and
    // client DOM agree. Without this, the hydration mismatch corrupts
    // ProseMirror's DOM<->position mapping and text selection stops working.
    immediatelyRender: false,
    extensions: [
      Document,
      Paragraph,
      Text,
      Bold,
      Italic,
      Heading.configure({ levels: [1, 2, 3] }),
      BulletList,
      OrderedList,
      ListItem,
      // Tab / Shift-Tab nesting plus smart Backspace/Delete at list edges.
      ListKeymap,
      ClauseDirectiveNode,
      InsertionMark,
      DeletionMark,
      History,
      Placeholder.configure({
        placeholder: placeholder ?? "",
      }),
    ],
    content: clauseBodyToTipTap(content),
    editorProps: {
      handleClick: (view, position) => {
        if (getAiState().status !== "reviewing") {
          return false;
        }
        const resolvedPosition = view.state.doc.resolve(position);
        const isTrackedChange = (mark: (typeof view.state.doc.marks)[number]) =>
          mark.type.name === INSERTION_MARK || mark.type.name === DELETION_MARK;
        const mark =
          resolvedPosition.nodeBefore?.marks.find(isTrackedChange) ??
          resolvedPosition.nodeAfter?.marks.find(isTrackedChange);
        const revisionId = mark?.attrs["revisionId"];
        if (typeof revisionId !== "number") {
          setHunkMenu(null);
          return false;
        }
        const coords = view.coordsAtPos(position);
        const rect = containerRef.current?.getBoundingClientRect();
        setHunkMenu({
          revisionId,
          top: coords.bottom - (rect?.top ?? 0),
          left: coords.left - (rect?.left ?? 0),
        });
        return false;
      },
    },
    onUpdate: ({ editor: e }) => {
      if (getAiState().status === "reviewing") {
        if (hasPendingTrackedChanges(e)) {
          return;
        }

        const resolvedBody = tipTapToClauseBody(e.getJSON());
        const resolvedKey = bodyKey(resolvedBody);
        const changed = resolvedKey !== lastEmittedKeyRef.current;
        lastEmittedKeyRef.current = resolvedKey;
        e.setEditable(true);
        setHunkMenu(null);
        setAiEdit({ status: "idle" });
        const persistHandlerPresent = hasReviewResolvedHandler();
        emitReviewStatus(
          reviewResolutionStatus(changed, persistHandlerPresent),
        );
        if (changed) {
          emitChange(resolvedBody);
          if (persistHandlerPresent) {
            // The accepted body still has to reach the server: keep
            // version-save actions gated on "persisting" until it does. The
            // persist call (onReviewResolved) reports "resolved" itself once
            // it actually succeeds; a failure surfaces its own toast and
            // leaves the gate blocked for a later successful retry (see
            // settleReviewPersist's doc for the full contract) instead of
            // unblocking unconditionally here.
            void settleReviewPersist(async () => {
              await emitReviewResolved(resolvedBody);
            });
          }
          // Without onReviewResolved there is no incremental persist to wait
          // on — reviewResolutionStatus already reported "resolved" above,
          // and the caller's own save flow (e.g. the create/edit dialog's
          // form submit) persists the accepted body later, by design.
        }
        return;
      }
      const body = tipTapToClauseBody(e.getJSON());
      lastEmittedKeyRef.current = bodyKey(body);
      emitChange(body);
    },
    onBlur: ({ editor: e }) => {
      if (getAiState().status === "reviewing") {
        return;
      }
      emitBlur(tipTapToClauseBody(e.getJSON()));
    },
  });

  // Re-seed the editor only on an external content change (not on the user's
  // own edits, whose key we already recorded above).
  const contentKey = bodyKey(content);
  const editorReady = isUsableEditor(editor);

  useExternalSyncEffect(() => {
    if (!isUsableEditor(editor)) {
      return undefined;
    }
    const currentAiState = getAiState();
    if (currentAiState.status === "reviewing") {
      if (contentKey !== bodyKey(currentAiState.baseline)) {
        setAiEdit({ status: "idle" });
        emitReviewStatus("resolved");
        editor.setEditable(true);
        setHunkMenu(null);
        editor
          .chain()
          .setMeta("addToHistory", false)
          .setContent(clauseBodyToTipTap(content), { emitUpdate: false })
          .run();
        lastEmittedKeyRef.current = contentKey;
      }
      return undefined;
    }
    if (contentKey !== lastEmittedKeyRef.current) {
      editor.commands.setContent(clauseBodyToTipTap(content));
      lastEmittedKeyRef.current = contentKey;
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- editor is a stable ref; only re-sync when contentKey changes
  }, [contentKey]);

  const runRewrite = async (instruction: string, baseline: ClauseBody) => {
    const trimmed = instruction.trim();
    if (trimmed === "") {
      return;
    }
    const generatingState = {
      status: "generating",
      instruction: trimmed,
      baseline,
    } as const;
    const requestId = rewriteRequestIdRef.current + 1;
    rewriteRequestIdRef.current = requestId;
    setAiEdit(generatingState);
    // Lock the editor for the request's duration: `baseline` is captured
    // now, and the tracked-change doc built below is index-aligned to it.
    // A concurrent keystroke while the rewrite streams would desync the
    // live doc from `baseline` and corrupt that alignment.
    if (isUsableEditor(editor)) {
      editor.setEditable(false);
    }
    const response = await api.clauses["ai-rewrite"].post({
      body: baseline,
      instruction: trimmed,
      usageNotes: usageNotes ?? null,
      title: title ?? null,
    });

    if (requestId !== rewriteRequestIdRef.current) {
      // Superseded by a newer request or a cancel — whichever owns the
      // current attempt also owns editor editability; don't touch it.
      return;
    }
    if (bodyKey(getContent()) !== bodyKey(baseline)) {
      setAiEdit({ status: "idle" });
      if (isUsableEditor(editor)) {
        editor.setEditable(true);
      }
      return;
    }
    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("ai.editWithAI"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      setAiEdit({ status: "prompting", instruction: trimmed });
      if (isUsableEditor(editor)) {
        editor.setEditable(true);
      }
      return;
    }
    if (!isUsableEditor(editor)) {
      setAiEdit({ status: "idle" });
      return;
    }

    const rewritten = response.data.body;
    if (!hasAlignedClauseStructure(baseline, rewritten)) {
      stellaToast.add({
        type: "error",
        title: t("ai.editWithAI"),
        description: t("clauses.aiStructureChanged"),
      });
      setAiEdit({ status: "prompting", instruction: trimmed });
      editor.setEditable(true);
      return;
    }

    const { doc, revisionIds } = buildTrackedChangeDoc(baseline, rewritten);
    if (revisionIds.length === 0) {
      stellaToast.add({
        type: "info",
        title: t("ai.editWithAI"),
        description: t("clauses.noChanges"),
      });
      setAiEdit({ status: "idle" });
      editor.setEditable(true);
      return;
    }

    const reviewingState = {
      status: "reviewing",
      instruction: trimmed,
      baseline,
    } as const;
    editor
      .chain()
      .setMeta("addToHistory", false)
      .setContent(doc, { emitUpdate: false })
      .run();
    editor.setEditable(false);
    setHunkMenu(null);
    setAiEdit(reviewingState);
    emitReviewStatus("pending");
  };

  const submitAiEdit = () => {
    if (aiEdit.status === "idle" || aiEdit.status === "generating") {
      return;
    }
    const baseline = aiEdit.status === "prompting" ? content : aiEdit.baseline;
    if (aiEdit.status === "reviewing" && isUsableEditor(editor)) {
      editor
        .chain()
        .setMeta("addToHistory", false)
        .setContent(clauseBodyToTipTap(baseline), { emitUpdate: false })
        .run();
      editor.setEditable(true);
      setHunkMenu(null);
      emitReviewStatus("resolved");
    }
    void runRewrite(aiEdit.instruction, baseline);
  };

  const runResolveCommand = (command: PMCommand) => {
    if (!isUsableEditor(editor)) {
      return;
    }
    setHunkMenu(null);
    editor.commands.command(({ state, dispatch }) =>
      command(state, nonHistoricalDispatch(dispatch)),
    );
  };

  const acceptAll = () => runResolveCommand(acceptAllChanges());
  const rejectAll = () => runResolveCommand(rejectAllChanges());
  const acceptHunk = (revisionId: number) =>
    runResolveCommand(acceptAIEditRevision(revisionId));
  const rejectHunk = (revisionId: number) =>
    runResolveCommand(rejectAIEditRevision(revisionId));

  const toggleAiEdit = () => {
    if (aiEdit.status === "idle") {
      setAiEdit({ status: "prompting", instruction: "" });
      return;
    }
    if (aiEdit.status === "reviewing") {
      rejectAll();
      return;
    }
    // Cancel a prompt or an in-flight generation. Bumping the request id
    // makes runRewrite's stale-response check skip restoring editability,
    // so this is the only place that does it for a cancelled generation.
    rewriteRequestIdRef.current += 1;
    setAiEdit({ status: "idle" });
    if (isUsableEditor(editor)) {
      editor.setEditable(true);
    }
  };

  const toggleBold = () => {
    if (!isUsableEditor(editor)) {
      return;
    }

    editor.chain().focus().toggleBold().run();
  };

  const toggleItalic = () => {
    if (!isUsableEditor(editor)) {
      return;
    }

    editor.chain().focus().toggleItalic().run();
  };

  const toggleHeading = (level: 1 | 2 | 3) => {
    if (!isUsableEditor(editor)) {
      return;
    }

    editor.chain().focus().toggleHeading({ level }).run();
  };

  const toggleBulletList = useCallback(() => {
    if (!isUsableEditor(editor)) {
      return;
    }

    editor.chain().focus().toggleBulletList().run();
  }, [editor]);

  const toggleOrderedList = useCallback(() => {
    if (!isUsableEditor(editor)) {
      return;
    }

    editor.chain().focus().toggleOrderedList().run();
  }, [editor]);

  const undo = useCallback(() => {
    if (!isUsableEditor(editor)) {
      return;
    }

    editor.chain().focus().undo().run();
  }, [editor]);

  const redo = useCallback(() => {
    if (!isUsableEditor(editor)) {
      return;
    }

    editor.chain().focus().redo().run();
  }, [editor]);

  const canUndo = editorReady && editor.can().undo();
  const canRedo = editorReady && editor.can().redo();
  const reviewing = aiEdit.status === "reviewing";
  const aiActive = aiEdit.status !== "idle";
  // Formatting/undo commands dispatch transactions directly, bypassing
  // TipTap's `editable: false` (which only blocks direct DOM interaction),
  // so the toolbar must disable them itself during review and generation.
  const editingLocked = reviewing || aiEdit.status === "generating";

  return (
    // Stop modifier key combos from propagating to global
    // hotkeys (e.g., Cmd+B toggles sidebar otherwise).
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- non-interactive editor wrapper; onKeyDown only stops modifier combos reaching global hotkeys, real input is the contenteditable inside
    <div
      className="clause-editor relative rounded-md border"
      onKeyDown={(e) => {
        if (e.metaKey || e.ctrlKey) {
          e.stopPropagation();
        }
      }}
      ref={containerRef}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 border-b px-1 py-0.5">
        <Button
          aria-label={t("folio.undo")}
          disabled={!canUndo || editingLocked}
          onClick={undo}
          size="icon-xs"
          title={t("folio.undo")}
          type="button"
          variant="ghost"
        >
          <Undo2Icon className="size-3.5" />
        </Button>
        <Button
          aria-label={t("folio.redo")}
          disabled={!canRedo || editingLocked}
          onClick={redo}
          size="icon-xs"
          title={t("folio.redo")}
          type="button"
          variant="ghost"
        >
          <Redo2Icon className="size-3.5" />
        </Button>
        <div className="bg-border mx-1 h-4 w-px" />
        <Button
          aria-label={t("folio.bold")}
          className={
            editorReady && editor.isActive("bold") ? "bg-muted" : undefined
          }
          disabled={!editorReady || editingLocked}
          onClick={toggleBold}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <BoldIcon className="size-3.5" />
        </Button>
        <Button
          aria-label={t("folio.italic")}
          className={
            editorReady && editor.isActive("italic") ? "bg-muted" : undefined
          }
          disabled={!editorReady || editingLocked}
          onClick={toggleItalic}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <ItalicIcon className="size-3.5" />
        </Button>
        <div className="bg-border mx-1 h-4 w-px" />
        <Button
          aria-label="H1"
          className={
            editorReady && editor.isActive("heading", { level: 1 })
              ? "bg-muted"
              : undefined
          }
          disabled={!editorReady || editingLocked}
          onClick={() => toggleHeading(1)}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <Heading1Icon className="size-3.5" />
        </Button>
        <Button
          aria-label="H2"
          className={
            editorReady && editor.isActive("heading", { level: 2 })
              ? "bg-muted"
              : undefined
          }
          disabled={!editorReady || editingLocked}
          onClick={() => toggleHeading(2)}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <Heading2Icon className="size-3.5" />
        </Button>
        <Button
          aria-label="H3"
          className={
            editorReady && editor.isActive("heading", { level: 3 })
              ? "bg-muted"
              : undefined
          }
          disabled={!editorReady || editingLocked}
          onClick={() => toggleHeading(3)}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <Heading3Icon className="size-3.5" />
        </Button>
        <div className="bg-border mx-1 h-4 w-px" />
        <Button
          aria-label={t("folio.bulletList")}
          className={
            editorReady && editor.isActive("bulletList")
              ? "bg-muted"
              : undefined
          }
          disabled={!editorReady || editingLocked}
          onClick={toggleBulletList}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <ListIcon className="size-3.5" />
        </Button>
        <Button
          aria-label={t("folio.numberedList")}
          className={
            editorReady && editor.isActive("orderedList")
              ? "bg-muted"
              : undefined
          }
          disabled={!editorReady || editingLocked}
          onClick={toggleOrderedList}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <ListOrderedIcon className="size-3.5" />
        </Button>

        <Button
          aria-label={t("ai.editWithAI")}
          className={cn("ms-auto", aiActive && "bg-muted")}
          disabled={!editorReady || aiEdit.status === "generating"}
          onClick={toggleAiEdit}
          size="icon-xs"
          title={t("ai.editWithAI")}
          type="button"
          variant="ghost"
        >
          <WandSparklesIcon className="size-3.5" />
        </Button>
      </div>

      <EditorContent editor={editor} />

      {hunkMenu && reviewing ? (
        <HunkMenu
          left={hunkMenu.left}
          onAccept={() => acceptHunk(hunkMenu.revisionId)}
          onReject={() => rejectHunk(hunkMenu.revisionId)}
          top={hunkMenu.top}
        />
      ) : null}

      <p
        className={cn(
          "text-muted-foreground border-t px-2 py-1 text-xs",
          aiActive && "pb-16",
        )}
      >
        {t("clauses.formattingPreviewHint")}
      </p>

      {aiEdit.status === "idle" ? null : (
        <AiEditBar
          instruction={aiEdit.instruction}
          onAcceptAll={acceptAll}
          onCancel={toggleAiEdit}
          onInstructionChange={updateInstruction}
          onRejectAll={rejectAll}
          onSubmit={submitAiEdit}
          status={aiEdit.status}
        />
      )}
    </div>
  );
};

type HunkMenuProps = {
  top: number;
  left: number;
  onAccept: () => void;
  onReject: () => void;
};

const HunkMenu = ({ top, left, onAccept, onReject }: HunkMenuProps) => {
  const t = useTranslations();

  return (
    <div
      className="bg-popover absolute z-20 flex items-center gap-0.5 rounded-md border p-0.5 shadow-md"
      style={{ top, left }}
    >
      <Button
        aria-label={t("common.accept")}
        onClick={onAccept}
        size="icon-xs"
        title={t("common.accept")}
        type="button"
        variant="ghost"
      >
        <CheckIcon className="size-3.5" />
      </Button>
      <Button
        aria-label={t("docxReview.reject")}
        onClick={onReject}
        size="icon-xs"
        title={t("docxReview.reject")}
        type="button"
        variant="ghost"
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
};

// ── AI edit bar ─────────────────────────────────────

type AiEditBarProps = {
  status: "prompting" | "generating" | "reviewing";
  instruction: string;
  onInstructionChange: (value: string) => void;
  onSubmit: () => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onCancel: () => void;
};

const AiEditBar = ({
  status,
  instruction,
  onInstructionChange,
  onSubmit,
  onAcceptAll,
  onRejectAll,
  onCancel,
}: AiEditBarProps) => {
  const t = useTranslations();
  const generating = status === "generating";
  const reviewing = status === "reviewing";

  return (
    <div className="bg-popover absolute inset-x-0 bottom-2 z-10 mx-auto flex w-[min(92%,32rem)] flex-col gap-2 rounded-lg border p-2 shadow-lg">
      <div className="flex items-start gap-2">
        <WandSparklesIcon className="text-muted-foreground mt-2 size-3.5 shrink-0" />
        <Textarea
          autoFocus
          className="min-h-9 flex-1 resize-none text-sm"
          disabled={generating}
          onChange={(e) => onInstructionChange(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder={t("ai.refinePlaceholder")}
          value={instruction}
        />
      </div>
      <div className="flex items-center justify-end gap-2">
        {reviewing ? (
          <Button onClick={onRejectAll} size="sm" type="button" variant="ghost">
            <XIcon className="size-3.5" />
            {t("docxReview.rejectAll")}
          </Button>
        ) : (
          <Button onClick={onCancel} size="sm" type="button" variant="ghost">
            {t("common.cancel")}
          </Button>
        )}
        <Button
          disabled={generating || instruction.trim() === ""}
          onClick={onSubmit}
          size="sm"
          type="button"
          variant={reviewing ? "ghost" : undefined}
        >
          <AiEditSubmitIcon generating={generating} reviewing={reviewing} />
          {reviewing ? t("common.regenerate") : t("ai.editWithAI")}
        </Button>
        {reviewing ? (
          <Button onClick={onAcceptAll} size="sm" type="button">
            <CheckIcon className="size-3.5" />
            {t("docxReview.acceptAll")}
          </Button>
        ) : null}
      </div>
    </div>
  );
};

const AiEditSubmitIcon = ({
  generating,
  reviewing,
}: {
  generating: boolean;
  reviewing: boolean;
}) => {
  if (generating) {
    return <Loader2Icon className="size-3.5 animate-spin" />;
  }
  if (reviewing) {
    return <RotateCcwIcon className="size-3.5" />;
  }
  return <WandSparklesIcon className="size-3.5" />;
};

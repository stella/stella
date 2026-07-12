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
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/components/button";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors/user-safe";

import { diffClauseBodies } from "./clause-diff";
import { ClauseDiffView } from "./clause-diff-view";
import { ClauseDirectiveNode } from "./clause-directive-extension";
import { clauseBodyToTipTap, tipTapToClauseBody } from "./clause-editor-tiptap";
import "./clause-editor.css";
import type { ClauseBody, ClauseParagraph } from "./clause-editor-types";

const isUsableEditor = (editor: Editor | null | undefined): editor is Editor =>
  editor !== null && editor !== undefined && !editor.isDestroyed;

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
  | {
      status: "preview";
      instruction: string;
      baseline: ClauseBody;
      revised: ClauseBody;
    };

type ClauseEditorProps = {
  content: ClauseParagraph[];
  onChange: (body: ClauseParagraph[]) => void;
  placeholder?: string;
  /** Fired when the editor loses focus, carrying the current body. */
  onBlur?: (body: ClauseParagraph[]) => void;
  /** Context passed to the AI refine assist (current, possibly unsaved values). */
  usageNotes?: string | undefined;
  title?: string;
};

export const ClauseEditor = ({
  content,
  onChange,
  placeholder,
  onBlur,
  usageNotes,
  title,
}: ClauseEditorProps) => {
  const t = useTranslations();
  // AI edit is a preview-then-apply flow: generate a rewrite, show it as a diff,
  // and mutate the clause only when the user accepts. The prompt stays editable
  // so the user can regenerate against the original body.
  const [aiEdit, setAiEdit] = useState<AiEditState>({ status: "idle" });

  const runRewrite = async (instruction: string, baseline: ClauseBody) => {
    const trimmed = instruction.trim();
    if (trimmed === "") {
      return;
    }
    setAiEdit({ status: "generating", instruction: trimmed, baseline });
    const response = await api.clauses["ai-rewrite"].post({
      body: baseline,
      instruction: trimmed,
      usageNotes: usageNotes ?? null,
      title: title ?? null,
    });
    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("ai.editWithAI"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      // Keep the prompt open with its text so the user can adjust and retry.
      setAiEdit({ status: "prompting", instruction: trimmed });
      return;
    }
    setAiEdit({
      status: "preview",
      instruction: trimmed,
      baseline,
      revised: response.data.body,
    });
  };

  const submitAiEdit = () => {
    if (aiEdit.status === "idle") {
      return;
    }
    const baseline = aiEdit.status === "prompting" ? content : aiEdit.baseline;
    void runRewrite(aiEdit.instruction, baseline);
  };

  const acceptAiEdit = () => {
    if (aiEdit.status !== "preview") {
      return;
    }
    onChange(aiEdit.revised);
    setAiEdit({ status: "idle" });
  };

  const updateInstruction = (value: string) => {
    setAiEdit((prev) => {
      if (prev.status === "prompting") {
        return { status: "prompting", instruction: value };
      }
      if (prev.status === "preview") {
        return { ...prev, instruction: value };
      }
      return prev;
    });
  };

  const toggleAiEdit = () => {
    setAiEdit((prev) =>
      prev.status === "idle"
        ? { status: "prompting", instruction: "" }
        : { status: "idle" },
    );
  };
  // Last body the editor itself emitted, so the reset effect can tell an
  // external content change (dialog reset, clause switch) from the round-trip
  // of the user's own keystroke and avoid clobbering the cursor.
  const lastEmittedKeyRef = useRef<string | null>(null);
  lastEmittedKeyRef.current ??= bodyKey(content);

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
      History,
      Placeholder.configure({
        placeholder: placeholder ?? "",
      }),
    ],
    content: clauseBodyToTipTap(content),
    onUpdate: ({ editor: e }) => {
      const body = tipTapToClauseBody(e.getJSON());
      lastEmittedKeyRef.current = bodyKey(body);
      onChange(body);
    },
    onBlur: ({ editor: e }) => {
      onBlur?.(tipTapToClauseBody(e.getJSON()));
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
    if (contentKey !== lastEmittedKeyRef.current) {
      editor.commands.setContent(clauseBodyToTipTap(content));
      lastEmittedKeyRef.current = contentKey;
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- editor is a stable ref; only re-sync when contentKey changes
  }, [contentKey]);

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
  const previewing = aiEdit.status === "preview";
  const aiActive = aiEdit.status !== "idle";

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
    >
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 border-b px-1 py-0.5">
        <Button
          aria-label={t("folio.undo")}
          disabled={!canUndo || previewing}
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
          disabled={!canRedo || previewing}
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
          disabled={!editorReady || previewing}
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
          disabled={!editorReady || previewing}
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
          disabled={!editorReady || previewing}
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
          disabled={!editorReady || previewing}
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
          disabled={!editorReady || previewing}
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
          disabled={!editorReady || previewing}
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
          disabled={!editorReady || previewing}
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

      {/* Editor area — hidden under an AI preview so the read-only diff can
          take its place without tearing down the live editor instance. */}
      <div className={cn(previewing && "hidden")}>
        <EditorContent editor={editor} />
      </div>
      {aiEdit.status === "preview" ? (
        <div className="px-3 py-2">
          <ClauseDiffView
            diffs={diffClauseBodies(aiEdit.baseline, aiEdit.revised)}
          />
        </div>
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
          onAccept={acceptAiEdit}
          onDiscard={() => setAiEdit({ status: "idle" })}
          onInstructionChange={updateInstruction}
          onSubmit={submitAiEdit}
          status={aiEdit.status}
        />
      )}
    </div>
  );
};

// ── AI edit bar ─────────────────────────────────────

type AiEditBarProps = {
  status: "prompting" | "generating" | "preview";
  instruction: string;
  onInstructionChange: (value: string) => void;
  onSubmit: () => void;
  onAccept: () => void;
  onDiscard: () => void;
};

const AiEditBar = ({
  status,
  instruction,
  onInstructionChange,
  onSubmit,
  onAccept,
  onDiscard,
}: AiEditBarProps) => {
  const t = useTranslations();
  const generating = status === "generating";
  const previewing = status === "preview";

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
        <Button onClick={onDiscard} size="sm" type="button" variant="ghost">
          {previewing ? <XIcon className="size-3.5" /> : null}
          {t("common.cancel")}
        </Button>
        <Button
          disabled={generating || instruction.trim() === ""}
          onClick={onSubmit}
          size="sm"
          type="button"
          variant={previewing ? "ghost" : undefined}
        >
          <AiEditSubmitIcon generating={generating} previewing={previewing} />
          {previewing ? t("common.regenerate") : t("ai.editWithAI")}
        </Button>
        {previewing ? (
          <Button onClick={onAccept} size="sm" type="button">
            <CheckIcon className="size-3.5" />
            {t("common.accept")}
          </Button>
        ) : null}
      </div>
    </div>
  );
};

const AiEditSubmitIcon = ({
  generating,
  previewing,
}: {
  generating: boolean;
  previewing: boolean;
}) => {
  if (generating) {
    return <Loader2Icon className="size-3.5 animate-spin" />;
  }
  if (previewing) {
    return <RotateCcwIcon className="size-3.5" />;
  }
  return <WandSparklesIcon className="size-3.5" />;
};

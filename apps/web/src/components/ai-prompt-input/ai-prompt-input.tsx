import { useMemo, useRef, useState } from "react";

import { useInfiniteQuery } from "@tanstack/react-query";
import type { AnyExtension } from "@tiptap/core";
import Paragraph from "@tiptap/extension-paragraph";
import Text from "@tiptap/extension-text";
import { Placeholder, UndoRedo } from "@tiptap/extensions";
import type { EditorProps } from "@tiptap/pm/view";
import { useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";

import "@/components/workspaces/properties/property-input/tiptap.css";
import { ScrollArea } from "@stll/ui/scroll-area";
import { cn } from "@stll/ui/utils";

import { AiRewriteControl } from "@/components/ai-rewrite-control";
import {
  buildChatSlashItems,
  commandShortcutRowsFromSkillPages,
  skillPagesForChips,
} from "@/components/chat-editor-slash-items";
import type { SkillChipCatalog } from "@/components/chat-editor-slash-items";
import { PastedText } from "@/components/chat-pasted-text-extension";
import {
  createPromptSlashSuggestion,
  PromptSlash,
} from "@/components/chat/prompt-slash-extension";
import type { SlashItem } from "@/components/chat/prompt-slash-extension";
import {
  PROMPT_EDITOR_SELECTION_CLASS,
  PromptEditorContent,
} from "@/components/prompt-editor";
import {
  createPromptEditorDocument,
  handlePromptEditorSelectAll,
} from "@/components/prompt-editor.logic";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { skillsOptions } from "@/lib/knowledge/queries";
import { useChatUnavailableSkillIds } from "@/lib/prompts/use-chat-unavailable-skills";
import { useQueryView } from "@/lib/use-query-view";

/**
 * How the controlled string `value` round-trips through the editor.
 *
 * - `html`: `value` is the editor's serialized HTML (mentions and skill
 *   chips embedded as elements). Used by callers that store rich markup.
 * - `text`: `value` is plain text. Skill chips serialize to their
 *   `[label](#stella-skill-ref=slug)` markdown form and field mentions to
 *   `{{path}}` via each node's `renderText`, so the stored string stays
 *   resolvable by a backend prompt consumer without HTML parsing.
 */
type AIPromptValueFormat = "html" | "text";

type AIPromptEditAction = {
  disabled: boolean;
  isPending: boolean;
  label: string;
  onClick: (instruction: string) => void;
};

type AIPromptInputProps = {
  value: string;
  onChange: (value: string) => void;
  onBlur?: (() => void) | undefined;
  /**
   * - `filled` (default): muted background, padded box, fixed scroll height.
   * - `minimal`: transparent, borderless, content-driven height. Used when
   *   the editor is embedded inside a card that already provides the frame.
   */
  variant?: "filled" | "minimal" | undefined;
  /** Controls how `value` is read in and emitted out (default `html`). */
  valueFormat?: AIPromptValueFormat | undefined;
  /** Which skills the `/` menu offers as chips. */
  skillChips: SkillChipCatalog;
  placeholder?: string | undefined;
  /**
   * Optional pre-configured TipTap extension wired for `@` references
   * (e.g. property or template-field mentions). Owned by the caller so the
   * shared core stays decoupled from any specific reference source.
   */
  mentionExtension?: AnyExtension | undefined;
  onEditorReady?: ((editor: Editor) => void) | undefined;
  onSubmit?: (() => void) | undefined;
  aiEditAction?: AIPromptEditAction | undefined;
  className?: string | undefined;
};

/**
 * Shared "AI instruction" input: a TipTap editor wired with `/` slash
 * prompts + skills (via `PromptSlash` + `buildChatSlashItems`) and an
 * optional `@` mention source. The value is a controlled string; skill
 * references serialize into it in the form `PromptSlash` already uses, so a
 * backend prompt consumer can later resolve them.
 *
 * Property-column descriptions and template AI-instruction fields both build
 * on this core; reference-source wiring stays with each caller.
 */
export const AIPromptInput = ({
  value,
  onChange,
  onBlur,
  variant = "filled",
  valueFormat = "html",
  skillChips,
  placeholder,
  mentionExtension,
  onEditorReady,
  onSubmit,
  aiEditAction,
  className,
}: AIPromptInputProps) => {
  const { activeOrganizationId, id: userId } = useAuthenticatedUser();
  const skillsQuery = useInfiniteQuery(
    skillsOptions(activeOrganizationId, userId),
  );
  const skillsView = useQueryView(skillsQuery, {
    isEmpty: (data) =>
      data.pages.every(
        (page) => page.builtIn.length === 0 && page.installed.length === 0,
      ),
  });
  const skillPages = skillsView.type === "items" ? skillsView.items : undefined;
  const {
    fetchNextPage: fetchNextSkillPage,
    hasNextPage: hasNextSkillPage,
    isFetchingNextPage: isFetchingNextSkillPage,
    isFetchNextPageError: isNextSkillPageError,
  } = skillsQuery;
  const unavailableSkillIds = useChatUnavailableSkillIds(
    activeOrganizationId,
    userId,
  );
  const slashShortcutRows = useMemo(
    () =>
      commandShortcutRowsFromSkillPages(skillPages?.pages, unavailableSkillIds),
    [skillPages, unavailableSkillIds],
  );
  useExternalSyncEffect(() => {
    if (!hasNextSkillPage || isFetchingNextSkillPage || isNextSkillPageError) {
      return;
    }
    detached(fetchNextSkillPage(), "ai-prompt-input.fetch-next-skill-page");
  }, [
    fetchNextSkillPage,
    hasNextSkillPage,
    isFetchingNextSkillPage,
    isNextSkillPageError,
  ]);
  const slashItems = useMemo<SlashItem[]>(
    () =>
      buildChatSlashItems({
        shortcuts: slashShortcutRows,
        skillPages:
          skillPages && skillPagesForChips(skillPages.pages, skillChips),
        unavailableSkillIds,
      }),
    [slashShortcutRows, skillChips, skillPages, unavailableSkillIds],
  );
  const getSlashItems = useLatestCallback(() => slashItems);

  const readValue = (editor: Editor): string =>
    valueFormat === "text" ? editor.getText() : editor.getHTML();

  // In text mode the controlled `value` is plain text, not HTML, so build a
  // ProseMirror JSON doc instead of letting TipTap parse the string as HTML
  // (which would drop angle-bracket text like `<client>`).
  const initialContent =
    valueFormat === "text"
      ? {
          type: "doc",
          content: value
            ? [{ type: "paragraph", content: [{ type: "text", text: value }] }]
            : [],
        }
      : value;

  // Everything passed to `useEditor` below (except event handlers) must keep
  // a stable identity across renders; the react binding re-applies changed
  // options to the live editor view, which can interleave with pending
  // ProseMirror DOM mutations and loop (require-stable-editor-options).
  // Extensions and content are creation-only anyway — the react binding never
  // reconfigures either after the editor exists — so capturing the first
  // render's values is faithful; dynamic bits route through latest getters.
  const getPlaceholder = useLatestCallback(() => placeholder ?? "");
  const getEditorClassName = useLatestCallback(() =>
    variant === "minimal"
      ? cn(
          PROMPT_EDITOR_SELECTION_CLASS,
          "placeholder:text-foreground-placeholder min-h-15 w-full text-sm leading-[1.55] focus-visible:outline-none",
          aiEditAction !== undefined && "pe-24",
        )
      : cn(
          PROMPT_EDITOR_SELECTION_CLASS,
          "bg-muted placeholder:text-foreground-placeholder min-h-32 w-full rounded-md p-2 text-sm focus-visible:outline-none",
          aiEditAction !== undefined && "pe-24",
        ),
  );
  const editorRef = useRef<Editor | null>(null);
  const handleEditorKeyDown = useLatestCallback(
    (event: KeyboardEvent): boolean => {
      if (
        onSubmit &&
        (event.metaKey || event.ctrlKey) &&
        event.key === "Enter"
      ) {
        event.preventDefault();
        event.stopPropagation();
        onSubmit();
        return true;
      }
      const currentEditor = editorRef.current;
      if (
        currentEditor !== null &&
        handlePromptEditorSelectAll(event, currentEditor)
      ) {
        return true;
      }
      return false;
    },
  );
  const [creationContent] = useState(() => initialContent);
  const [extensions] = useState(() => [
    createPromptEditorDocument(),
    Paragraph,
    Text,
    PastedText,
    Placeholder.configure({
      placeholder: () => getPlaceholder(),
      showOnlyWhenEditable: false,
    }),
    ...(mentionExtension ? [mentionExtension] : []),
    PromptSlash.configure({
      suggestion: createPromptSlashSuggestion(getSlashItems),
    }),
    UndoRedo,
  ]);
  const [editorProps] = useState<EditorProps>(() => ({
    attributes: () => ({ class: getEditorClassName() }),
    handleKeyDown: (_view, event) => handleEditorKeyDown(event),
  }));

  const editor = useEditor({
    content: creationContent,
    editorProps,
    extensions,
    onBlur: () => onBlur?.(),
    onCreate: ({ editor: createdEditor }) => {
      editorRef.current = createdEditor;
    },
    onUpdate: (props) => {
      onChange(readValue(props.editor));
    },
  });

  useExternalSyncEffect(() => {
    if (onEditorReady !== undefined) {
      onEditorReady(editor);
    }
  }, [editor, onEditorReady]);

  // With the options identity-stable, ProseMirror only re-evaluates the
  // captured placeholder and attributes callbacks when view props are
  // re-applied or a transaction commits. Re-apply them exactly when a dynamic
  // input changes so the placeholder and class (variant / edit-action
  // padding) update without reintroducing per-render option churn.
  const hasAiEditAction = aiEditAction !== undefined;
  useExternalSyncEffect(() => {
    if (editor.isDestroyed) {
      return;
    }
    editor.setOptions({});
  }, [editor, hasAiEditAction, placeholder, variant]);

  // `useEditor` only reads `content` once at creation, so a controlled `value`
  // that changes from outside (switching the edited prompt, or a parent reset)
  // would leave the editor showing stale text. Re-sync the document when the
  // editor's serialized value diverges from `value`. `emitUpdate: false` keeps
  // this from looping back through `onUpdate` → `onChange`; the equality guard
  // makes the editor's own edits a no-op so the caret is never disturbed.
  const syncControlledValue = useLatestCallback(() => {
    if (editor.isDestroyed || readValue(editor) === value) {
      return;
    }
    editor.commands.setContent(initialContent, { emitUpdate: false });
  });
  useExternalSyncEffect(syncControlledValue, [
    editor,
    value,
    valueFormat,
    syncControlledValue,
  ]);

  return (
    <div className={cn("relative w-full", className)}>
      <QueryViewFeedback view={skillsView} />
      {variant === "minimal" ? (
        <PromptEditorContent
          className="w-full [&_.ProseMirror]:w-full"
          editor={editor}
        />
      ) : (
        <ScrollArea className="h-32 overflow-y-auto">
          <PromptEditorContent
            className="w-full [&_.ProseMirror]:w-full"
            editor={editor}
          />
        </ScrollArea>
      )}
      {aiEditAction !== undefined && (
        <AiRewriteControl
          className={cn(
            "text-muted-foreground hover:text-foreground absolute end-0 top-0",
            variant === "filled" && "end-1 top-1",
          )}
          disabled={aiEditAction.disabled}
          isPending={aiEditAction.isPending}
          label={aiEditAction.label}
          onRewrite={aiEditAction.onClick}
        />
      )}
    </div>
  );
};

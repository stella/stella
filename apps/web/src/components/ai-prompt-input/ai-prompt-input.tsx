import { useMemo, useRef } from "react";

import { useInfiniteQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import type { AnyExtension } from "@tiptap/core";
import History from "@tiptap/extension-history";
import Paragraph from "@tiptap/extension-paragraph";
import Placeholder from "@tiptap/extension-placeholder";
import Text from "@tiptap/extension-text";
import { useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { Loader2Icon, WandSparklesIcon } from "lucide-react";

import "@/routes/_protected.workspaces/$workspaceId/-components/properties/property-input/tiptap.css";
import { Button } from "@stll/ui/components/button";
import { ScrollArea } from "@stll/ui/components/scroll-area";
import { cn } from "@stll/ui/lib/utils";

import {
  buildChatSlashItems,
  commandShortcutRowsFromSkillPages,
} from "@/components/chat-editor-slash-items";
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
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { detached } from "@/lib/detached";
import { skillsOptions } from "@/routes/_protected.knowledge/-queries";

const protectedRouteApi = getRouteApi("/_protected");

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
export type AIPromptValueFormat = "html" | "text";

type AIPromptEditAction = {
  disabled: boolean;
  isPending: boolean;
  label: string;
  onClick: () => void;
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
  placeholder,
  mentionExtension,
  onEditorReady,
  onSubmit,
  aiEditAction,
  className,
}: AIPromptInputProps) => {
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const {
    data: skillPages,
    fetchNextPage: fetchNextSkillPage,
    hasNextPage: hasNextSkillPage,
    isFetchingNextPage: isFetchingNextSkillPage,
  } = useInfiniteQuery(skillsOptions(activeOrganizationId));
  const slashShortcutRows = useMemo(
    () => commandShortcutRowsFromSkillPages(skillPages?.pages),
    [skillPages],
  );
  useExternalSyncEffect(() => {
    if (!hasNextSkillPage || isFetchingNextSkillPage) {
      return;
    }
    detached(fetchNextSkillPage(), "AIPromptInput");
  }, [fetchNextSkillPage, hasNextSkillPage, isFetchingNextSkillPage]);
  const slashItemsRef = useRef<SlashItem[]>([]);
  // eslint-disable-next-line react/react-compiler -- latest-value ref mirror: the memoized slash items are read later by the TipTap suggestion factory (outside render), never during render
  slashItemsRef.current = useMemo<SlashItem[]>(
    () =>
      buildChatSlashItems({
        shortcuts: slashShortcutRows,
        skillPages: skillPages?.pages,
      }),
    [slashShortcutRows, skillPages],
  );

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

  const editor = useEditor({
    extensions: [
      createPromptEditorDocument(),
      Paragraph,
      Text,
      PastedText,
      Placeholder.configure({
        placeholder: placeholder ?? "",
        showOnlyWhenEditable: false,
      }),
      ...(mentionExtension ? [mentionExtension] : []),
      PromptSlash.configure({
        // eslint-disable-next-line react/react-compiler -- ref read runs inside the TipTap suggestion callback (invoked outside render), not during render
        suggestion: createPromptSlashSuggestion(() => slashItemsRef.current),
      }),
      History,
    ],
    content: initialContent,
    onUpdate: (props) => {
      onChange(readValue(props.editor));
    },
    onBlur: () => onBlur?.(),
    editorProps: {
      attributes: {
        class:
          variant === "minimal"
            ? cn(
                PROMPT_EDITOR_SELECTION_CLASS,
                "placeholder:text-foreground-placeholder min-h-15 w-full text-sm leading-[1.55] focus-visible:outline-none",
                aiEditAction !== undefined && "pe-10",
              )
            : cn(
                PROMPT_EDITOR_SELECTION_CLASS,
                "bg-muted placeholder:text-foreground-placeholder min-h-32 w-full rounded-md p-2 text-sm focus-visible:outline-none",
                aiEditAction !== undefined && "pe-10",
              ),
      },
      handleKeyDown: (_view, event) => {
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
        if (handlePromptEditorSelectAll(event, editor)) {
          return true;
        }
        return false;
      },
    },
  });

  useExternalSyncEffect(() => {
    if (onEditorReady !== undefined) {
      onEditorReady(editor);
    }
  }, [editor, onEditorReady]);

  // `useEditor` only reads `content` once at creation, so a controlled `value`
  // that changes from outside (switching the edited prompt, or a parent reset)
  // would leave the editor showing stale text. Re-sync the document when the
  // editor's serialized value diverges from `value`. `emitUpdate: false` keeps
  // this from looping back through `onUpdate` → `onChange`; the equality guard
  // makes the editor's own edits a no-op so the caret is never disturbed.
  useExternalSyncEffect(() => {
    if (editor.isDestroyed || readValue(editor) === value) {
      return;
    }
    editor.commands.setContent(initialContent, { emitUpdate: false });
    // `readValue`/`initialContent` derive solely from `value`/`valueFormat`,
    // which are the tracked deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, value, valueFormat]);

  return (
    <div className={cn("relative w-full", className)}>
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
        <Button
          aria-label={aiEditAction.label}
          className={cn(
            "text-muted-foreground hover:text-foreground absolute end-0 top-0 size-7",
            variant === "filled" && "end-1 top-1",
          )}
          disabled={aiEditAction.disabled}
          onClick={aiEditAction.onClick}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          size="icon-sm"
          title={aiEditAction.label}
          type="button"
          variant="ghost"
        >
          {aiEditAction.isPending ? (
            <Loader2Icon aria-hidden className="size-3.5 animate-spin" />
          ) : (
            <WandSparklesIcon aria-hidden className="size-3.5" />
          )}
        </Button>
      )}
    </div>
  );
};

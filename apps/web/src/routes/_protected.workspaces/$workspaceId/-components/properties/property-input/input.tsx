import { useEffect, useMemo, useRef } from "react";
import type React from "react";

import {
  useInfiniteQuery,
  useQuery,
  useSuspenseQuery,
} from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import History from "@tiptap/extension-history";
import Paragraph from "@tiptap/extension-paragraph";
import Placeholder from "@tiptap/extension-placeholder";

import "./tiptap.css";
import Text from "@tiptap/extension-text";
import { useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { Loader2Icon, WandSparklesIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import * as v from "valibot";

import { Button } from "@stll/ui/components/button";
import { FieldError } from "@stll/ui/components/field";
import { ScrollArea } from "@stll/ui/components/scroll-area";
import { cn } from "@stll/ui/lib/utils";

import { buildChatSlashItems } from "@/components/chat-editor-slash-items";
import { PastedText } from "@/components/chat-pasted-text-extension";
import {
  createPromptSlashSuggestion,
  PromptSlash,
} from "@/components/chat/prompt-slash-extension";
import type { SlashItem } from "@/components/chat/prompt-slash-extension";
import {
  createPromptEditorDocument,
  handlePromptEditorSelectAll,
  PROMPT_EDITOR_SELECTION_CLASS,
  PromptEditorContent,
} from "@/components/prompt-editor";
import {
  skillCommandsOptions,
  skillsOptions,
} from "@/routes/_protected.knowledge/-queries";
import { PropertyFormField } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/form";
import {
  createCustomMention,
  createSuggestion,
} from "@/routes/_protected.workspaces/$workspaceId/-components/properties/property-input/custom-mention";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";

const protectedRouteApi = getRouteApi("/_protected");

const mentionAttrsSchema = v.object({
  id: v.string(),
});

const getMentions = (editor: Editor): string[] => {
  const mentions = new Set<string>();

  editor.state.doc.descendants((node) => {
    if (node.type.name === "mention") {
      const result = v.safeParse(mentionAttrsSchema, node.attrs);
      if (result.success) {
        mentions.add(result.output.id);
      }
    }
  });

  return [...mentions];
};

// Narrow handle that both AnyFieldApi (TanStack form) and a
// plain useState wrapper can satisfy structurally. Avoids
// requiring a real form context just to embed this editor.
export type PropertyPromptFieldHandle = {
  name: string;
  state: { value: string };
  handleChange: (value: string) => void;
  handleBlur: () => void;
};

type PropertyPromptInputProps = {
  workspaceId: string;
  propertyId: string;
  propertyName: string;
  onMentionsChange: (mentions: string[]) => void;
  field: PropertyPromptFieldHandle;
  dependenciesField?: React.ReactElement;
  onEditorReady?: (editor: Editor) => void;
  autoPopulateOnEmpty?: boolean;
  /**
   * - `filled` (default): muted background, padded box, fixed scroll height.
   *   Used inside form fields where the input needs its own visual frame.
   * - `minimal`: transparent, borderless, content-driven height. Used when
   *   the editor is embedded inside a larger composer card that already
   *   provides the frame.
   */
  variant?: "filled" | "minimal";
  placeholder?: string;
  onSubmit?: () => void;
  aiEditAction?: {
    disabled: boolean;
    isPending: boolean;
    label: string;
    onClick: () => void;
  };
};

export const PropertyPromptInput = ({
  workspaceId,
  propertyId,
  propertyName,
  onMentionsChange,
  field,
  dependenciesField,
  onEditorReady,
  autoPopulateOnEmpty = true,
  variant = "filled",
  placeholder,
  onSubmit,
  aiEditAction,
}: PropertyPromptInputProps) => {
  const t = useTranslations();
  const didAutoPopulate = useRef(false);
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const suggestionOptions = properties
    .map((item) => ({ id: item.id, label: item.name }))
    .filter((item) => item.id !== propertyId);
  const fileProperty = properties.find((p) => p.content.type === "file");

  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const { data: commandSkills = [] } = useQuery(
    skillCommandsOptions(activeOrganizationId),
  );
  const { data: skillPages } = useInfiniteQuery(
    skillsOptions(activeOrganizationId),
  );
  // See chat-editor-provider for the rationale on adapting the
  // dedicated command-skills endpoint to the legacy slash shape.
  const slashShortcutRows = useMemo(
    () =>
      commandSkills.flatMap((row) =>
        row.command === null
          ? []
          : [
              {
                id: row.id,
                scope: row.scope,
                name: row.name,
                command: row.command,
                prompt: row.body,
              },
            ],
      ),
    [commandSkills],
  );
  const slashItemsRef = useRef<SlashItem[]>([]);
  slashItemsRef.current = useMemo<SlashItem[]>(
    () =>
      buildChatSlashItems({
        shortcuts: slashShortcutRows,
        skillPages: skillPages?.pages,
      }),
    [slashShortcutRows, skillPages],
  );

  const editor = useEditor({
    extensions: [
      createPromptEditorDocument(),
      Paragraph,
      Text,
      PastedText,
      Placeholder.configure({
        placeholder:
          placeholder ?? t("workspaces.properties.setPromptPlaceholder"),
        showOnlyWhenEditable: false,
      }),
      createCustomMention(workspaceId).configure({
        suggestion: createSuggestion(suggestionOptions),
        deleteTriggerWithBackspace: true,
      }),
      PromptSlash.configure({
        suggestion: createPromptSlashSuggestion(() => slashItemsRef.current),
      }),
      History,
    ],
    content: field.state.value,
    onUpdate: (props) => {
      const mentions = getMentions(props.editor);
      onMentionsChange(mentions);
      field.handleChange(props.editor.getHTML());
    },
    onBlur: field.handleBlur,
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

  useEffect(() => {
    if (onEditorReady !== undefined) {
      onEditorReady(editor);
    }
  }, [editor, onEditorReady]);

  // Auto-populate prompt with file reference when the editor
  // is empty and a file property exists.
  useEffect(() => {
    if (
      !autoPopulateOnEmpty ||
      didAutoPopulate.current ||
      fileProperty === undefined ||
      field.state.value.length > 0
    ) {
      return;
    }

    didAutoPopulate.current = true;

    const label =
      propertyName || t("workspaces.properties.defaultPromptPropertyName");
    const prefix = t("workspaces.properties.defaultPromptPrefix", {
      propertyName: label,
    });

    editor
      .chain()
      .focus()
      .insertContent(prefix)
      .insertContent({
        type: "mention",
        attrs: {
          id: fileProperty.id,
          label: fileProperty.name,
        },
      })
      .run();

    const mentions = getMentions(editor);
    onMentionsChange(mentions);
    field.handleChange(editor.getHTML());
  }, [
    autoPopulateOnEmpty,
    editor,
    fileProperty,
    field,
    propertyName,
    t,
    onMentionsChange,
  ]);

  return (
    <div className="group w-full gap-1">
      <PropertyFormField className="w-full p-0" name={field.name}>
        <div className="relative">
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
        <FieldError />
      </PropertyFormField>
      {dependenciesField}
    </div>
  );
};

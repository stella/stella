import { useEffect, useRef } from "react";
import type React from "react";

import { FieldError } from "@stll/ui/components/field";
import { ScrollArea } from "@stll/ui/components/scroll-area";
import { cn } from "@stll/ui/lib/utils";

import "./tiptap.css";
import { useSuspenseQuery } from "@tanstack/react-query";
import Document from "@tiptap/extension-document";
import History from "@tiptap/extension-history";
import Paragraph from "@tiptap/extension-paragraph";
import Placeholder from "@tiptap/extension-placeholder";
import Text from "@tiptap/extension-text";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { useTranslations } from "use-intl";

import { PropertyFormField } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/form";
import {
  createSuggestion,
  CustomMention,
} from "@/routes/_protected.workspaces/$workspaceId/-components/properties/property-input/custom-mention";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";

const getMentions = (editor: Editor): string[] => {
  const mentions = new Set<string>();

  editor.state.doc.descendants((node) => {
    if (node.type.name === "mention") {
      // TODO: FIXME — ProseMirror node.attrs is Record<string, any>
      // oxlint-disable-next-line typescript-eslint/no-unsafe-argument
      mentions.add(node.attrs["id"]);
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
}: PropertyPromptInputProps) => {
  const t = useTranslations();
  const didAutoPopulate = useRef(false);
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const suggestionOptions = properties
    .map((item) => ({ id: item.id, label: item.name }))
    .filter((item) => item.id !== propertyId);
  const fileProperty = properties.find((p) => p.content.type === "file");
  const editor = useEditor({
    extensions: [
      Document,
      Paragraph,
      Text,
      Placeholder.configure({
        placeholder: t("workspaces.properties.setPromptPlaceholder"),
        showOnlyWhenEditable: false,
      }),
      CustomMention.configure({
        suggestion: createSuggestion(suggestionOptions),
        deleteTriggerWithBackspace: true,
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
        class: cn(
          "bg-muted placeholder:text-muted-foreground/64 min-h-32 w-full rounded-md p-2 text-sm focus-visible:outline-none",
        ),
      },
    },
  });

  useEffect(() => {
    if (editor !== null && onEditorReady !== undefined) {
      onEditorReady(editor);
    }
  }, [editor, onEditorReady]);

  // Auto-populate prompt with file reference when the editor
  // is empty and a file property exists.
  useEffect(() => {
    if (
      !autoPopulateOnEmpty ||
      didAutoPopulate.current ||
      editor === undefined ||
      editor === null ||
      fileProperty === undefined ||
      fileProperty === null ||
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
        <ScrollArea className="h-32 overflow-y-auto">
          <EditorContent editor={editor} />
        </ScrollArea>
        <FieldError />
      </PropertyFormField>
      {dependenciesField}
    </div>
  );
};

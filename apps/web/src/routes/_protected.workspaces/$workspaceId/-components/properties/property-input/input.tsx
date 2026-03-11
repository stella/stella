import { useEffect, useRef } from "react";
import type React from "react";

import type { AnyFieldApi } from "@tanstack/react-form";
import { useSuspenseQuery } from "@tanstack/react-query";
import Document from "@tiptap/extension-document";
import History from "@tiptap/extension-history";

import "./tiptap.css";
import Paragraph from "@tiptap/extension-paragraph";
import Placeholder from "@tiptap/extension-placeholder";
import Text from "@tiptap/extension-text";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor } from "@tiptap/react";
import { useTranslations } from "use-intl";

import { FieldError } from "@stella/ui/components/field";
import { ScrollArea } from "@stella/ui/components/scroll-area";
import { cn } from "@stella/ui/lib/utils";

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
      mentions.add(node.attrs.id);
    }
  });

  return [...mentions];
};

type PropertyPromptInputProps = {
  workspaceId: string;
  propertyId: string;
  propertyName: string;
  onMentionsChange: (mentions: string[]) => void;
  field: AnyFieldApi;
  dependenciesField: React.ReactElement;
};

export const PropertyPromptInput = ({
  workspaceId,
  propertyId,
  propertyName,
  onMentionsChange,
  field,
  dependenciesField,
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

  // Auto-populate prompt with file reference when the editor
  // is empty and a file property exists.
  useEffect(() => {
    if (
      didAutoPopulate.current ||
      !editor ||
      !fileProperty ||
      field.state.value
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
  }, [editor, fileProperty, field, propertyName, t, onMentionsChange]);

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

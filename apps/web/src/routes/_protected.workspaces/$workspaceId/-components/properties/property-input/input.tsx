import { useEffect, useRef, useState } from "react";
import type React from "react";

import { useSuspenseQuery } from "@tanstack/react-query";
import type { Editor } from "@tiptap/react";
import { useTranslations } from "use-intl";

import { FieldError } from "@stll/ui/components/field";

import { AIPromptInput } from "@/components/ai-prompt-input/ai-prompt-input";
import { PropertyFormField } from "@/routes/_protected.workspaces/$workspaceId/-components/properties/form";
import {
  createCustomMention,
  createSuggestion,
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
  const [editor, setEditor] = useState<Editor | null>(null);
  const { data: properties } = useSuspenseQuery(propertiesOptions(workspaceId));
  const suggestionOptions = properties
    .map((item) => ({ id: item.id, label: item.name }))
    .filter((item) => item.id !== propertyId);
  const fileProperty = properties.find((p) => p.content.type === "file");

  const mentionExtension = createCustomMention(workspaceId).configure({
    suggestion: createSuggestion(suggestionOptions),
    deleteTriggerWithBackspace: true,
  });

  const handleChange = (html: string) => {
    if (editor !== null) {
      onMentionsChange(getMentions(editor));
    }
    field.handleChange(html);
  };

  const handleEditorReady = (next: Editor) => {
    setEditor(next);
    onEditorReady?.(next);
  };

  // Auto-populate prompt with file reference when the editor
  // is empty and a file property exists.
  useEffect(() => {
    if (
      !autoPopulateOnEmpty ||
      didAutoPopulate.current ||
      fileProperty === undefined ||
      editor === null ||
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

    onMentionsChange(getMentions(editor));
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
        <AIPromptInput
          aiEditAction={aiEditAction}
          mentionExtension={mentionExtension}
          onBlur={field.handleBlur}
          onChange={handleChange}
          onEditorReady={handleEditorReady}
          onSubmit={onSubmit}
          placeholder={
            placeholder ?? t("workspaces.properties.setPromptPlaceholder")
          }
          value={field.state.value}
          variant={variant}
        />
        <FieldError />
      </PropertyFormField>
      {dependenciesField}
    </div>
  );
};

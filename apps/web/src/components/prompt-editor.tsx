import "./prompt-editor.css";
import type React from "react";

import { EditorContent } from "@tiptap/react";
import type { Editor } from "@tiptap/react";

import { cn } from "@stll/ui/lib/utils";

export const PROMPT_EDITOR_SELECTION_CLASS = "prompt-editor-selection";

type PromptEditorContentProps = Omit<
  React.ComponentProps<typeof EditorContent>,
  "editor"
> & {
  editor: Editor | null;
};

export const PromptEditorContent = ({
  className,
  editor,
  ...props
}: PromptEditorContentProps) => (
  <EditorContent
    className={cn(PROMPT_EDITOR_SELECTION_CLASS, className)}
    editor={editor}
    {...props}
  />
);

import { useCallback, useEffect } from "react";

import Bold from "@tiptap/extension-bold";
import Document from "@tiptap/extension-document";
import Heading from "@tiptap/extension-heading";
import History from "@tiptap/extension-history";
import Italic from "@tiptap/extension-italic";
import Paragraph from "@tiptap/extension-paragraph";
import Placeholder from "@tiptap/extension-placeholder";
import Text from "@tiptap/extension-text";
import { EditorContent, useEditor } from "@tiptap/react";
import type { JSONContent } from "@tiptap/react";
import {
  BoldIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ItalicIcon,
} from "lucide-react";

import { Button } from "@stll/ui/components/button";

import "./clause-editor.css";
import type { ClauseParagraph, ClauseRun } from "./clause-editor-types";

// ── Conversion: ClauseBody → TipTap JSON ────────────

const clauseBodyToTipTap = (body: readonly ClauseParagraph[]): JSONContent => ({
  type: "doc",
  content: body
    .filter((p) => !p.isDirective)
    .map((p): JSONContent => {
      const isHeading = p.style === "heading" && p.level !== undefined;
      const runs = p.runs ?? [{ text: p.text }];

      const content: JSONContent[] = runs.map((run): JSONContent => {
        const marks: { type: string }[] = [];
        if (run.bold) {
          marks.push({ type: "bold" });
        }
        if (run.italic) {
          marks.push({ type: "italic" });
        }
        const node: JSONContent = {
          type: "text",
          text: run.text || " ",
        };
        if (marks.length > 0) {
          node.marks = marks;
        }
        return node;
      });

      if (isHeading) {
        return {
          type: "heading",
          attrs: {
            level: Math.min(p.level ?? 1, 3),
          },
          content,
        };
      }

      return { type: "paragraph", content };
    }),
});

// ── Conversion: TipTap JSON → ClauseBody ────────────

const tipTapToClauseBody = (json: JSONContent): ClauseParagraph[] => {
  const content = json.content ?? [];

  return content.map((node): ClauseParagraph => {
    const isHeading = node.type === "heading";
    const runs: ClauseRun[] = [];
    let plainText = "";

    for (const child of node.content ?? []) {
      if (child.type === "text" && child.text) {
        const bold = child.marks?.some((m) => m.type === "bold");
        const italic = child.marks?.some((m) => m.type === "italic");

        const run: ClauseRun = { text: child.text };
        if (bold) {
          run.bold = true;
        }
        if (italic) {
          run.italic = true;
        }
        runs.push(run);

        plainText += child.text;
      }
    }

    // If all runs are unstyled, omit the runs array
    const hasFormatting = runs.some((r) => r.bold || r.italic);

    const paragraph: ClauseParagraph = { text: plainText };
    if (hasFormatting) {
      paragraph.runs = runs;
    }
    if (isHeading) {
      paragraph.style = "heading";
      paragraph.level =
        typeof node.attrs?.["level"] === "number" ? node.attrs["level"] : 1;
    }
    return paragraph;
  });
};

// ── Editor Component ────────────────────────────────

type ClauseEditorProps = {
  content: ClauseParagraph[];
  onChange: (body: ClauseParagraph[]) => void;
  placeholder?: string;
};

export const ClauseEditor = ({
  content,
  onChange,
  placeholder,
}: ClauseEditorProps) => {
  const editor = useEditor({
    extensions: [
      Document,
      Paragraph,
      Text,
      Bold,
      Italic,
      Heading.configure({ levels: [1, 2, 3] }),
      History,
      Placeholder.configure({
        placeholder: placeholder ?? "",
      }),
    ],
    content: clauseBodyToTipTap(content),
    onUpdate: ({ editor: e }) => {
      onChange(tipTapToClauseBody(e.getJSON()));
    },
  });

  // Sync content when the dialog resets
  const contentKey = content.map((p) => p.text).join("\n");

  useEffect(() => {
    const currentText = editor.getText();
    if (currentText !== contentKey) {
      editor.commands.setContent(clauseBodyToTipTap(content));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- editor and content are stable refs; only re-sync when contentKey changes
  }, [contentKey]);

  const toggleBold = useCallback(() => {
    editor.chain().focus().toggleBold().run();
  }, [editor]);

  const toggleItalic = useCallback(() => {
    editor.chain().focus().toggleItalic().run();
  }, [editor]);

  const toggleHeading = useCallback(
    (level: 1 | 2 | 3) => {
      editor.chain().focus().toggleHeading({ level }).run();
    },
    [editor],
  );

  return (
    // Stop modifier key combos from propagating to global
    // hotkeys (e.g., Cmd+B toggles sidebar otherwise).
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions
    <div
      className="clause-editor rounded-md border"
      onKeyDown={(e) => {
        if (e.metaKey || e.ctrlKey) {
          e.stopPropagation();
        }
      }}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 border-b px-1 py-0.5">
        <Button
          className={editor.isActive("bold") ? "bg-muted" : undefined}
          onClick={toggleBold}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <BoldIcon className="size-3.5" />
        </Button>
        <Button
          className={editor.isActive("italic") ? "bg-muted" : undefined}
          onClick={toggleItalic}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <ItalicIcon className="size-3.5" />
        </Button>
        <div className="bg-border mx-1 h-4 w-px" />
        <Button
          className={
            editor.isActive("heading", { level: 1 }) ? "bg-muted" : undefined
          }
          onClick={() => toggleHeading(1)}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <Heading1Icon className="size-3.5" />
        </Button>
        <Button
          className={
            editor.isActive("heading", { level: 2 }) ? "bg-muted" : undefined
          }
          onClick={() => toggleHeading(2)}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <Heading2Icon className="size-3.5" />
        </Button>
        <Button
          className={
            editor.isActive("heading", { level: 3 }) ? "bg-muted" : undefined
          }
          onClick={() => toggleHeading(3)}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <Heading3Icon className="size-3.5" />
        </Button>
      </div>

      {/* Editor area */}
      <EditorContent editor={editor} />
    </div>
  );
};

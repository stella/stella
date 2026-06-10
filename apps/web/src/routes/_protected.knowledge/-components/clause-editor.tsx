import { useRef } from "react";

import Bold from "@tiptap/extension-bold";
import Document from "@tiptap/extension-document";
import Heading from "@tiptap/extension-heading";
import History from "@tiptap/extension-history";
import Italic from "@tiptap/extension-italic";
import Paragraph from "@tiptap/extension-paragraph";
import Placeholder from "@tiptap/extension-placeholder";
import Text from "@tiptap/extension-text";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor, JSONContent } from "@tiptap/react";
import {
  BoldIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ItalicIcon,
} from "lucide-react";

import { Button } from "@stll/ui/components/button";

import { useExternalSyncEffect } from "@/hooks/use-effect";

import {
  CLAUSE_DIRECTIVE_NODE,
  ClauseDirectiveNode,
  isBlockDirectiveKind,
} from "./clause-directive-node";
import "./clause-editor.css";
import type { ClauseParagraph, ClauseRun } from "./clause-editor-types";

const isUsableEditor = (editor: Editor | null | undefined): editor is Editor =>
  editor !== null && editor !== undefined && !editor.isDestroyed;

// ── Conversion: ClauseBody → TipTap JSON ────────────

const directiveToNode = (p: ClauseParagraph): JSONContent => ({
  type: CLAUSE_DIRECTIVE_NODE,
  attrs: {
    kind: p.directiveKind ?? "if",
    expression: p.directiveExpression ?? "",
    text: p.text,
  },
});

export const clauseBodyToTipTap = (
  body: readonly ClauseParagraph[],
): JSONContent => ({
  type: "doc",
  content: body.map((p): JSONContent => {
    // Directives ride in the document as atomic nodes, so their position is
    // the editor's truth rather than something reconstructed on save.
    if (p.isDirective) {
      return directiveToNode(p);
    }

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

const nodeToDirective = (node: JSONContent): ClauseParagraph => {
  const attrs = node.attrs ?? {};
  const kind = isBlockDirectiveKind(attrs["kind"]) ? attrs["kind"] : "if";
  return {
    text: typeof attrs["text"] === "string" ? attrs["text"] : "",
    isDirective: true,
    directiveKind: kind,
    directiveExpression:
      typeof attrs["expression"] === "string" ? attrs["expression"] : "",
  };
};

export const tipTapToClauseBody = (json: JSONContent): ClauseParagraph[] => {
  const content = json.content ?? [];

  return content.map((node): ClauseParagraph => {
    if (node.type === CLAUSE_DIRECTIVE_NODE) {
      return nodeToDirective(node);
    }

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

/** Stable identity of a body for detecting external resets vs. the editor's
 *  own round-tripped edits (text + formatting + directive kind/expression). */
const bodyKey = (body: readonly ClauseParagraph[]): string =>
  body
    .map((p) =>
      p.isDirective
        ? `D:${p.directiveKind ?? ""}:${p.directiveExpression ?? ""}`
        : `P:${p.style ?? ""}:${p.level ?? ""}:${(p.runs ?? [{ text: p.text }])
            .map((r) => `${r.bold ? "b" : ""}${r.italic ? "i" : ""}|${r.text}`)
            .join("\u0001")}`,
    )
    .join("\u0000");

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
  // Last body the editor itself emitted, so the reset effect can tell an
  // external content change (dialog reset, clause switch) from the round-trip
  // of the user's own keystroke and avoid clobbering the cursor.
  const lastEmittedKeyRef = useRef(bodyKey(content));

  const editor = useEditor({
    extensions: [
      Document,
      Paragraph,
      Text,
      Bold,
      Italic,
      Heading.configure({ levels: [1, 2, 3] }),
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

  return (
    // Stop modifier key combos from propagating to global
    // hotkeys (e.g., Cmd+B toggles sidebar otherwise).
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- non-interactive editor wrapper; onKeyDown only stops modifier combos reaching global hotkeys, real input is the contenteditable inside
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
          className={
            editorReady && editor.isActive("bold") ? "bg-muted" : undefined
          }
          disabled={!editorReady}
          onClick={toggleBold}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <BoldIcon className="size-3.5" />
        </Button>
        <Button
          className={
            editorReady && editor.isActive("italic") ? "bg-muted" : undefined
          }
          disabled={!editorReady}
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
            editorReady && editor.isActive("heading", { level: 1 })
              ? "bg-muted"
              : undefined
          }
          disabled={!editorReady}
          onClick={() => toggleHeading(1)}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <Heading1Icon className="size-3.5" />
        </Button>
        <Button
          className={
            editorReady && editor.isActive("heading", { level: 2 })
              ? "bg-muted"
              : undefined
          }
          disabled={!editorReady}
          onClick={() => toggleHeading(2)}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <Heading2Icon className="size-3.5" />
        </Button>
        <Button
          className={
            editorReady && editor.isActive("heading", { level: 3 })
              ? "bg-muted"
              : undefined
          }
          disabled={!editorReady}
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

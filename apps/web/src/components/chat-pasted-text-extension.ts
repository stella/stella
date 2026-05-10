import { mergeAttributes, Node } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";

import { ChatPastedTextNode } from "@/components/chat-pasted-text-node";

export const PASTED_TEXT_NODE_NAME = "pastedText";

export const PASTED_TEXT_SOURCES = ["paste", "prompt"] as const;
export type PastedTextSource = (typeof PASTED_TEXT_SOURCES)[number];

export type PastedTextAttrs = {
  text: string;
  label: string;
  source: PastedTextSource;
};

const isPastedTextSource = (value: unknown): value is PastedTextSource =>
  typeof value === "string" &&
  (PASTED_TEXT_SOURCES as readonly string[]).includes(value);

type InsertPastedTextChipOptions = {
  /** When set, replace this range (e.g. the `/skill` trigger). */
  replaceRange?: { from: number; to: number };
};

/**
 * Insert a pasted-text chip and trail it with a space, so the cursor
 * lands on a normal text run after the atom node — matching how
 * users expect to keep typing after a paste or skill insert.
 *
 * After the insert we explicitly collapse the browser selection to
 * the end (mirroring `@tiptap/extension-mention`'s default suggestion
 * command). Without this, ProseMirror leaves a NodeSelection on the
 * inserted inline atom, and the next keystroke would replace the
 * chip with the typed character.
 */
export const insertPastedTextChip = (
  editor: Editor,
  attrs: PastedTextAttrs,
  { replaceRange }: InsertPastedTextChipOptions = {},
): boolean => {
  const content = [
    { type: PASTED_TEXT_NODE_NAME, attrs },
    { type: "text", text: " " },
  ];
  const ran = replaceRange
    ? editor.chain().focus().insertContentAt(replaceRange, content).run()
    : editor.chain().focus().insertContent(content).run();
  editor.view.dom.ownerDocument.defaultView?.getSelection()?.collapseToEnd();
  return ran;
};

/**
 * Atom inline node that renders a "[Pasted N characters]" chip in the
 * composer. The full text lives on the node attrs and is emitted as
 * a child text node in `renderHTML`, so the API-side sanitizer
 * (`<pasted-text>` is not in the allow-list) unwraps the tag and the
 * model receives the raw text. Visual collapse is composer-only.
 */
export const PastedText = Node.create({
  name: PASTED_TEXT_NODE_NAME,
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    return {
      text: {
        default: "",
        parseHTML: (el: HTMLElement) => el.textContent ?? "",
        renderHTML: () => ({}),
      },
      label: {
        default: "",
        parseHTML: (el: HTMLElement) => el.dataset["label"] ?? "",
        renderHTML: (attrs: Record<string, unknown>) =>
          typeof attrs["label"] === "string" && attrs["label"].length > 0
            ? { "data-label": attrs["label"] }
            : {},
      },
      source: {
        default: "paste" satisfies PastedTextSource,
        parseHTML: (el: HTMLElement) => {
          const raw = el.dataset["source"];
          return isPastedTextSource(raw) ? raw : "paste";
        },
        renderHTML: (attrs: Record<string, unknown>) => ({
          "data-source": isPastedTextSource(attrs["source"])
            ? attrs["source"]
            : "paste",
        }),
      },
    };
  },

  parseHTML() {
    return [{ tag: "pasted-text" }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const text =
      typeof node.attrs["text"] === "string" ? node.attrs["text"] : "";
    return ["pasted-text", mergeAttributes(HTMLAttributes), text];
  },

  renderText({ node }) {
    return typeof node.attrs["text"] === "string" ? node.attrs["text"] : "";
  },

  addNodeView() {
    return ReactNodeViewRenderer(ChatPastedTextNode);
  },
});

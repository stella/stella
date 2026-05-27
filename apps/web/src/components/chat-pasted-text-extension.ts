import { mergeAttributes, Node } from "@tiptap/core";
import type { Editor } from "@tiptap/core";
import { ReactNodeViewRenderer } from "@tiptap/react";

import { ChatPastedTextNode } from "@/components/chat-pasted-text-node";

export const PASTED_TEXT_NODE_NAME = "pastedText";

export const PASTED_TEXT_SOURCES = ["paste", "prompt", "skill"] as const;
export const SKILL_CHIP_HREF_PREFIX = "#stella-skill-ref=";
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
 * After insertion we explicitly drop a `TextSelection` at the end of
 * the inserted content. Without it ProseMirror keeps a NodeSelection
 * on the inline atom, and the next keystroke would replace the chip
 * with the typed character.
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
  const chain = editor.chain().focus();
  const ran = replaceRange
    ? chain.insertContentAt(replaceRange, content).run()
    : chain.insertContent(content).run();
  editor.commands.setTextSelection(editor.state.selection.to);
  return ran;
};

type RenderChild = string | readonly ["br"];

/**
 * Build the inline-content children for the `<pasted-text>` element
 * out of the stored text, splitting on `\n` and inserting `<br>`s
 * between lines. The API sanitizer keeps `<br>` (the `<pasted-text>`
 * wrapper itself is unwrapped), and `html-to-markdown.ts` converts
 * `<br>` to `"  \n"` — preserving newlines that would otherwise be
 * collapsed by inline whitespace normalization.
 */
export const buildPastedTextRenderChildren = (text: string): RenderChild[] => {
  const lines = text.split("\n");
  const children: RenderChild[] = [];
  for (const [index, line] of lines.entries()) {
    if (index > 0) {
      children.push(["br"] as const);
    }
    if (line.length > 0) {
      children.push(line);
    }
  }
  return children;
};

/**
 * Read the underlying text out of a `<pasted-text>` element. Walks
 * direct children so that `<br>` separators round-trip back to `\n`
 * instead of vanishing the way `textContent` would.
 */
const parsePastedTextContent = (el: HTMLElement): string => {
  let result = "";
  for (const child of Array.from(el.childNodes)) {
    if (child instanceof HTMLBRElement) {
      result += "\n";
      continue;
    }
    result += child.textContent ?? "";
  }
  return result;
};

/**
 * Atom inline node that renders a "[Pasted N characters]" chip in the
 * composer. The full text lives on the node attrs and is emitted in
 * `renderHTML` with `<br>` between lines, so the API-side sanitizer
 * (`<pasted-text>` is not in the allow-list) unwraps the tag while
 * the `<br>`s — which the allow-list keeps — preserve newlines
 * through `htmlToMarkdown`'s inline-whitespace collapse. Visual
 * collapse is composer-only.
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
        parseHTML: parsePastedTextContent,
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
    const source = isPastedTextSource(node.attrs["source"])
      ? node.attrs["source"]
      : "paste";
    if (source === "skill") {
      const label =
        typeof node.attrs["label"] === "string" && node.attrs["label"].length > 0
          ? node.attrs["label"]
          : text;
      return [
        "pasted-text",
        mergeAttributes(HTMLAttributes),
        ["a", { href: `${SKILL_CHIP_HREF_PREFIX}${text}` }, label],
      ];
    }
    return [
      "pasted-text",
      mergeAttributes(HTMLAttributes),
      ...buildPastedTextRenderChildren(text),
    ];
  },

  renderText({ node }) {
    const text =
      typeof node.attrs["text"] === "string" ? node.attrs["text"] : "";
    const source = isPastedTextSource(node.attrs["source"])
      ? node.attrs["source"]
      : "paste";
    if (source === "skill") {
      const label =
        typeof node.attrs["label"] === "string" && node.attrs["label"].length > 0
          ? node.attrs["label"]
          : text;
      return `[${label}](${SKILL_CHIP_HREF_PREFIX}${text})`;
    }
    return text;
  },

  addNodeView() {
    return ReactNodeViewRenderer(ChatPastedTextNode);
  },
});

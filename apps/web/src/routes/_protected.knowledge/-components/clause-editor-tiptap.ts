import type { JSONContent } from "@tiptap/react";

import { optionalArray } from "@/lib/arrays";

import {
  CLAUSE_DIRECTIVE_NODE,
  isBlockDirectiveKind,
} from "./clause-directive-extension";
import type {
  ClauseListKind,
  ClauseParagraph,
  ClauseRun,
} from "./clause-editor-types";
import { DELETION_MARK } from "./clause-tracked-change-marks";

const listNodeType = (kind: ClauseListKind): "bulletList" | "orderedList" =>
  kind === "bullet" ? "bulletList" : "orderedList";

const listKindOfNode = (type: string | undefined): ClauseListKind | null => {
  if (type === "bulletList") {
    return "bullet";
  }
  if (type === "orderedList") {
    return "ordered";
  }
  return null;
};

// ── Conversion: ClauseBody → TipTap JSON ────────────

const directiveToNode = (p: ClauseParagraph): JSONContent => ({
  type: CLAUSE_DIRECTIVE_NODE,
  attrs: {
    kind: p.directiveKind ?? "if",
    expression: p.directiveExpression ?? "",
    text: p.text,
  },
});

const runsToInline = (runs: readonly ClauseRun[]): JSONContent[] =>
  runs.map((run): JSONContent => {
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

export type ParagraphContentOverride = (
  paragraph: ClauseParagraph,
  index: number,
) => JSONContent[] | null;

const paragraphToNode = (
  p: ClauseParagraph,
  contentOverride?: JSONContent[] | null,
): JSONContent => {
  const isHeading = p.style === "heading" && p.level !== undefined;
  const content = contentOverride ?? runsToInline(p.runs ?? [{ text: p.text }]);

  if (isHeading) {
    return {
      type: "heading",
      attrs: { level: Math.min(p.level ?? 1, 3) },
      content,
    };
  }
  return { type: "paragraph", content };
};

const listLevelOf = (p: ClauseParagraph): number =>
  p.listKind ? Math.max(0, p.listLevel ?? 0) : 0;

/**
 * Build the TipTap list node(s) for one run of consecutive list paragraphs
 * (all sharing `start.listKind` at the current level), nesting deeper levels as
 * child lists inside the preceding `listItem`. Returns the list node plus the
 * number of paragraphs it consumed, so the caller can resume after the run.
 */
const buildList = (
  body: readonly ClauseParagraph[],
  start: number,
  level: number,
  kind: ClauseListKind,
  override?: ParagraphContentOverride,
): { node: JSONContent; consumed: number } => {
  const items: JSONContent[] = [];
  let i = start;

  while (i < body.length) {
    const p = body[i];
    if (!p || p.isDirective || !p.listKind) {
      break;
    }
    const pLevel = listLevelOf(p);
    if (pLevel < level || (pLevel === level && p.listKind !== kind)) {
      break;
    }
    if (pLevel > level) {
      // A deeper item with no own-level parent: nest it under the last item,
      // or open a fresh item so the structure stays well-formed.
      const child = buildList(body, i, pLevel, p.listKind, override);
      const lastItem = items.at(-1);
      if (lastItem?.content) {
        lastItem.content.push(child.node);
      } else {
        items.push({ type: "listItem", content: [child.node] });
      }
      i += child.consumed;
      continue;
    }

    // paragraphToNode ignores list props, so the item's inner paragraph is
    // just the paragraph itself; buildList owns the list/nesting structure.
    const itemContent: JSONContent[] = [paragraphToNode(p, override?.(p, i))];
    i += 1;
    // Pull any immediately-following deeper items into this item as a sub-list.
    const next = body[i];
    if (next?.listKind && listLevelOf(next) > level) {
      const child = buildList(
        body,
        i,
        listLevelOf(next),
        next.listKind,
        override,
      );
      itemContent.push(child.node);
      i += child.consumed;
    }
    items.push({ type: "listItem", content: itemContent });
  }

  return {
    node: { type: listNodeType(kind), content: items },
    consumed: i - start,
  };
};

export const clauseBodyToTipTap = (
  body: readonly ClauseParagraph[],
  override?: ParagraphContentOverride,
): JSONContent => {
  const content: JSONContent[] = [];
  let i = 0;

  while (i < body.length) {
    const p = body[i];
    if (!p) {
      i += 1;
      continue;
    }
    // Directives ride in the document as atomic nodes, so their position is
    // the editor's truth rather than something reconstructed on save.
    if (p.isDirective) {
      content.push(directiveToNode(p));
      i += 1;
      continue;
    }
    if (p.listKind) {
      const built = buildList(body, i, listLevelOf(p), p.listKind, override);
      content.push(built.node);
      i += built.consumed;
      continue;
    }
    content.push(paragraphToNode(p, override?.(p, i)));
    i += 1;
  }

  return { type: "doc", content };
};

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

/** Extract a single paragraph/heading node (its inline runs + heading style). */
const nodeToParagraph = (node: JSONContent): ClauseParagraph => {
  const isHeading = node.type === "heading";
  const runs: ClauseRun[] = [];
  let plainText = "";

  const inlineContent = optionalArray(node.content);
  for (const child of inlineContent) {
    if (child.type === "text" && child.text) {
      if (child.marks?.some((mark) => mark.type === DELETION_MARK)) {
        continue;
      }

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
};

/**
 * Flatten a `bulletList`/`orderedList` node to list-item paragraphs at `level`.
 * Each `listItem` contributes one paragraph (its leading block) tagged with the
 * list kind + level; any nested list inside the item recurses one level deeper.
 */
const flattenList = (
  listNode: JSONContent,
  kind: ClauseListKind,
  level: number,
  out: ClauseParagraph[],
): void => {
  const listItems = optionalArray(listNode.content);
  for (const item of listItems) {
    if (item.type !== "listItem") {
      continue;
    }
    const blocks = optionalArray(item.content);
    // The item's own text comes first; a list item must carry at least one
    // marker line even if it holds nothing but a nested list.
    const leadBlock = blocks.find((b) => listKindOfNode(b.type) === null);
    const lead = leadBlock ? nodeToParagraph(leadBlock) : { text: "" };
    lead.listKind = kind;
    lead.listLevel = level;
    out.push(lead);

    for (const block of blocks) {
      const childKind = listKindOfNode(block.type);
      if (childKind) {
        flattenList(block, childKind, level + 1, out);
      }
    }
  }
};

export const tipTapToClauseBody = (json: JSONContent): ClauseParagraph[] => {
  const body: ClauseParagraph[] = [];

  const documentContent = optionalArray(json.content);
  for (const node of documentContent) {
    if (node.type === CLAUSE_DIRECTIVE_NODE) {
      body.push(nodeToDirective(node));
      continue;
    }
    const kind = listKindOfNode(node.type);
    if (kind) {
      flattenList(node, kind, 0, body);
      continue;
    }
    body.push(nodeToParagraph(node));
  }

  return body;
};

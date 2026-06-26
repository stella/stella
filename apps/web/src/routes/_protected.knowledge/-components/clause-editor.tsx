import { useCallback, useRef, useState } from "react";

import Bold from "@tiptap/extension-bold";
import Document from "@tiptap/extension-document";
import Heading from "@tiptap/extension-heading";
import History from "@tiptap/extension-history";
import Italic from "@tiptap/extension-italic";
import {
  BulletList,
  ListItem,
  ListKeymap,
  OrderedList,
} from "@tiptap/extension-list";
import Paragraph from "@tiptap/extension-paragraph";
import Placeholder from "@tiptap/extension-placeholder";
import Text from "@tiptap/extension-text";
import type { Command as PMCommand } from "@tiptap/pm/state";
import { EditorContent, useEditor } from "@tiptap/react";
import type { Editor, JSONContent } from "@tiptap/react";
import {
  BoldIcon,
  CheckIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ItalicIcon,
  ListIcon,
  ListOrderedIcon,
  Loader2Icon,
  Redo2Icon,
  RotateCcwIcon,
  Undo2Icon,
  WandSparklesIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import {
  acceptAIEditRevision,
  acceptAllChanges,
  diffWordSegments,
  rejectAIEditRevision,
  rejectAllChanges,
} from "@stll/folio";
import { Button } from "@stll/ui/components/button";
import { Textarea } from "@stll/ui/components/textarea";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import { useExternalSyncEffect } from "@/hooks/use-effect";
import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors";

import {
  CLAUSE_DIRECTIVE_NODE,
  ClauseDirectiveNode,
  isBlockDirectiveKind,
} from "./clause-directive-node";
import "./clause-editor.css";
import type {
  ClauseBody,
  ClauseListKind,
  ClauseParagraph,
  ClauseRun,
} from "./clause-editor-types";
import {
  DELETION_MARK,
  DeletionMark,
  INSERTION_MARK,
  InsertionMark,
} from "./clause-tracked-change-marks";

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

/**
 * Override a paragraph's inline content by body index. Returns replacement
 * inline nodes (e.g. tracked-change runs) or `null` to fall back to the
 * paragraph's own runs. Lets the tracked-change builder reuse the exact same
 * structure walk instead of re-deriving list/heading nesting.
 */
type ParagraphContentOverride = (
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

  for (const child of node.content ?? []) {
    if (child.type === "text" && child.text) {
      // Safety net: never serialize text still wrapped in a deletion mark, even
      // if a save somehow fires with unresolved tracked changes pending.
      if (child.marks?.some((m) => m.type === DELETION_MARK)) {
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
  for (const item of listNode.content ?? []) {
    if (item.type !== "listItem") {
      continue;
    }
    const blocks = item.content ?? [];
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

  for (const node of json.content ?? []) {
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

/** Stable identity of a body for detecting external resets vs. the editor's
 *  own round-tripped edits (text + formatting + directive kind/expression). */
const bodyKey = (body: readonly ClauseParagraph[]): string =>
  body
    .map((p) =>
      p.isDirective
        ? `D:${p.directiveKind ?? ""}:${p.directiveExpression ?? ""}`
        : `P:${p.style ?? ""}:${p.level ?? ""}:${p.listKind ?? ""}:${p.listLevel ?? ""}:${(
            p.runs ?? [{ text: p.text }]
          )
            .map((r) => `${r.bold ? "b" : ""}${r.italic ? "i" : ""}|${r.text}`)
            .join("\u0001")}`,
    )
    .join("\u0000");

// ── AI tracked changes ──────────────────────────────

// The suggesting author for AI edits. Accept/reject match by revisionId, so
// this is only carried for rendering/attribution, never for resolution.
const TRACKED_AUTHOR = "ai";

// Monotonic revision ids for a session. Folio's resolver matches changes by
// this id; uniqueness across edits is all that matters.
let nextRevisionId = Math.floor(Date.now());

/**
 * Inline nodes for one changed paragraph: equal runs as plain text, removed
 * runs carrying the deletion mark, added runs carrying the insertion mark — all
 * sharing one revisionId so the paragraph's edit accepts/rejects as a unit.
 */
const buildTrackedInline = (
  oldText: string,
  newText: string,
  revisionId: number,
  date: string,
): JSONContent[] => {
  const nodes: JSONContent[] = [];
  for (const segment of diffWordSegments(oldText, newText)) {
    if (segment.text === "") {
      continue;
    }
    if (segment.type === "equal") {
      nodes.push({ type: "text", text: segment.text });
      continue;
    }
    nodes.push({
      type: "text",
      text: segment.text,
      marks: [
        {
          type: segment.type === "ins" ? INSERTION_MARK : DELETION_MARK,
          attrs: { revisionId, author: TRACKED_AUTHOR, date },
        },
      ],
    });
  }
  return nodes;
};

type TrackedChangeDoc = { doc: JSONContent; revisionIds: number[] };

/**
 * Build a TipTap doc that renders the AI revision as inline tracked changes.
 * `rewrite.ts` returns an index-aligned body (same length/structure, only prose
 * text swapped), so a paragraph changed iff its text differs at the same index;
 * the structure walk is reused via `clauseBodyToTipTap`'s content override.
 */
export const buildTrackedChangeDoc = (
  baseline: readonly ClauseParagraph[],
  revised: readonly ClauseParagraph[],
): TrackedChangeDoc => {
  const date = new Date().toISOString();
  const revisionIds: number[] = [];
  const idByIndex = new Map<number, number>();

  const count = Math.min(baseline.length, revised.length);
  for (let i = 0; i < count; i++) {
    const before = baseline[i];
    const after = revised[i];
    if (!before || !after || before.isDirective || after.isDirective) {
      continue;
    }
    if (before.text === after.text) {
      continue;
    }
    const id = nextRevisionId++;
    idByIndex.set(i, id);
    revisionIds.push(id);
  }

  const override: ParagraphContentOverride = (paragraph, index) => {
    const id = idByIndex.get(index);
    if (id === undefined) {
      return null;
    }
    return buildTrackedInline(
      baseline[index]?.text ?? "",
      paragraph.text,
      id,
      date,
    );
  };

  return { doc: clauseBodyToTipTap(revised, override), revisionIds };
};

/** Whether the doc still holds any unresolved AI tracked-change mark. */
const hasPendingTrackedChanges = (editor: Editor): boolean => {
  let pending = false;
  editor.state.doc.descendants((node) => {
    if (pending) {
      return false;
    }
    if (
      node.isText &&
      node.marks.some(
        (m) => m.type.name === INSERTION_MARK || m.type.name === DELETION_MARK,
      )
    ) {
      pending = true;
      return false;
    }
    return true;
  });
  return pending;
};

// ── Editor Component ────────────────────────────────

type AiEditState =
  | { status: "idle" }
  | { status: "prompting"; instruction: string }
  | { status: "generating"; instruction: string; baseline: ClauseBody }
  | { status: "reviewing"; instruction: string; baseline: ClauseBody };

type ClauseEditorProps = {
  content: ClauseParagraph[];
  onChange: (body: ClauseParagraph[]) => void;
  placeholder?: string;
  /** Fired when the editor loses focus, carrying the current body. */
  onBlur?: (body: ClauseParagraph[]) => void;
  /** Context passed to the AI refine assist (current, possibly unsaved values). */
  usageNotes?: string | undefined;
  title?: string;
};

export const ClauseEditor = ({
  content,
  onChange,
  placeholder,
  onBlur,
  usageNotes,
  title,
}: ClauseEditorProps) => {
  const t = useTranslations();
  // AI edit is a generate-then-review flow: a rewrite lands inline as tracked
  // changes (insertion/deletion marks) and the clause is mutated only as the
  // user accepts/rejects each change. The prompt stays editable so the user can
  // regenerate against the original body.
  const [aiEdit, setAiEdit] = useState<AiEditState>({ status: "idle" });
  const [hunkMenu, setHunkMenu] = useState<{
    revisionId: number;
    top: number;
    left: number;
  } | null>(null);

  // Read inside the editor's stable onUpdate/onBlur/handleClick closures, which
  // capture the first render. Refs keep them reading the live values.
  const aiStateRef = useRef<AiEditState>(aiEdit);
  aiStateRef.current = aiEdit;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onBlurRef = useRef(onBlur);
  onBlurRef.current = onBlur;

  const updateInstruction = (value: string) => {
    setAiEdit((prev) => {
      if (prev.status === "prompting") {
        return { status: "prompting", instruction: value };
      }
      if (prev.status === "reviewing") {
        return { ...prev, instruction: value };
      }
      return prev;
    });
  };
  // Last body the editor itself emitted, so the reset effect can tell an
  // external content change (dialog reset, clause switch) from the round-trip
  // of the user's own keystroke and avoid clobbering the cursor.
  const lastEmittedKeyRef = useRef(bodyKey(content));
  // Anchor for positioning the inline accept/reject menu over a tracked change.
  const containerRef = useRef<HTMLDivElement>(null);

  const editor = useEditor({
    // Inline on an SSR'd page (unlike the old modal, which only mounted
    // client-side): defer editor creation to the client so the server and
    // client DOM agree. Without this, the hydration mismatch corrupts
    // ProseMirror's DOM<->position mapping and text selection stops working.
    immediatelyRender: false,
    extensions: [
      Document,
      Paragraph,
      Text,
      Bold,
      Italic,
      Heading.configure({ levels: [1, 2, 3] }),
      BulletList,
      OrderedList,
      ListItem,
      // Tab / Shift-Tab nesting plus smart Backspace/Delete at list edges.
      ListKeymap,
      ClauseDirectiveNode,
      // Tracked-change marks for AI edits; resolved by the shared folio
      // accept/reject commands.
      InsertionMark,
      DeletionMark,
      History,
      Placeholder.configure({
        placeholder: placeholder ?? "",
      }),
    ],
    content: clauseBodyToTipTap(content),
    editorProps: {
      // While reviewing, clicking a tracked change opens its accept/reject menu.
      handleClick: (view, pos) => {
        if (aiStateRef.current.status !== "reviewing") {
          return false;
        }
        const $pos = view.state.doc.resolve(pos);
        const marks = [
          ...($pos.nodeBefore?.marks ?? []),
          ...($pos.nodeAfter?.marks ?? []),
        ];
        const mark = marks.find(
          (m) =>
            m.type.name === INSERTION_MARK || m.type.name === DELETION_MARK,
        );
        const revisionId = mark?.attrs["revisionId"];
        if (typeof revisionId !== "number") {
          setHunkMenu(null);
          return false;
        }
        const coords = view.coordsAtPos(pos);
        const rect = containerRef.current?.getBoundingClientRect();
        setHunkMenu({
          revisionId,
          top: coords.bottom - (rect?.top ?? 0),
          left: coords.left - (rect?.left ?? 0),
        });
        return false;
      },
    },
    onUpdate: ({ editor: e }) => {
      // While reviewing, suppress autosave until every AI change is resolved —
      // a doc with pending marks would serialise both struck and inserted text.
      if (aiStateRef.current.status === "reviewing") {
        if (hasPendingTrackedChanges(e)) {
          return;
        }
        const resolved = tipTapToClauseBody(e.getJSON());
        const key = bodyKey(resolved);
        // Reject-all returns to baseline; skip the emit so cancelling an AI edit
        // doesn't mark the clause dirty or trigger an autosave.
        const changed = key !== lastEmittedKeyRef.current;
        lastEmittedKeyRef.current = key;
        e.setEditable(true);
        setHunkMenu(null);
        setAiEdit({ status: "idle" });
        if (changed) {
          onChangeRef.current(resolved);
        }
        return;
      }
      const body = tipTapToClauseBody(e.getJSON());
      lastEmittedKeyRef.current = bodyKey(body);
      onChangeRef.current(body);
    },
    onBlur: ({ editor: e }) => {
      if (aiStateRef.current.status === "reviewing") {
        return;
      }
      onBlurRef.current?.(tipTapToClauseBody(e.getJSON()));
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
    // Mid-review, keep the pending tracked changes in place — unless the parent
    // switched to a different clause, in which case discard the review and load
    // the new content so the editor never stays stuck on the old clause.
    if (aiStateRef.current.status === "reviewing") {
      if (contentKey !== bodyKey(aiStateRef.current.baseline)) {
        setAiEdit({ status: "idle" });
        editor.setEditable(true);
        setHunkMenu(null);
        editor.commands.setContent(clauseBodyToTipTap(content));
        lastEmittedKeyRef.current = contentKey;
      }
      return undefined;
    }
    if (contentKey !== lastEmittedKeyRef.current) {
      editor.commands.setContent(clauseBodyToTipTap(content));
      lastEmittedKeyRef.current = contentKey;
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- editor is a stable ref; only re-sync when contentKey changes
  }, [contentKey]);

  const runRewrite = async (instruction: string, baseline: ClauseBody) => {
    const trimmed = instruction.trim();
    if (trimmed === "") {
      return;
    }
    setAiEdit({ status: "generating", instruction: trimmed, baseline });
    const response = await api.clauses["ai-rewrite"].post({
      body: baseline,
      instruction: trimmed,
      usageNotes: usageNotes ?? null,
      title: title ?? null,
    });
    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("ai.editWithAI"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      // Keep the prompt open with its text so the user can adjust and retry.
      setAiEdit({ status: "prompting", instruction: trimmed });
      return;
    }
    if (!isUsableEditor(editor)) {
      return;
    }
    // The index-aligned diff assumes the rewrite preserves the paragraph/directive
    // structure. An LLM can drift (add/drop a paragraph, flip a directive); bail to
    // the prompt instead of rendering a misaligned diff.
    const rewritten = response.data.body;
    const isStructurallyAligned =
      baseline.length === rewritten.length &&
      baseline.every(
        (p, idx) =>
          Boolean(p.isDirective) === Boolean(rewritten[idx]?.isDirective),
      );
    if (!isStructurallyAligned) {
      stellaToast.add({
        type: "error",
        title: t("ai.editWithAI"),
        description: t("clauses.aiStructureChanged"),
      });
      setAiEdit({ status: "prompting", instruction: trimmed });
      return;
    }
    const { doc, revisionIds } = buildTrackedChangeDoc(baseline, rewritten);
    if (revisionIds.length === 0) {
      stellaToast.add({
        type: "info",
        title: t("ai.editWithAI"),
        description: t("clauses.noChanges"),
      });
      setAiEdit({ status: "idle" });
      return;
    }
    // Set the ref before applying so the suppression in onUpdate is in effect
    // even though setContent fires synchronously, before the state commits.
    aiStateRef.current = {
      status: "reviewing",
      instruction: trimmed,
      baseline,
    };
    editor.commands.setContent(doc, { emitUpdate: false });
    editor.setEditable(false);
    setHunkMenu(null);
    setAiEdit({ status: "reviewing", instruction: trimmed, baseline });
  };

  const submitAiEdit = () => {
    if (aiEdit.status === "idle" || aiEdit.status === "generating") {
      return;
    }
    const baseline = aiEdit.status === "prompting" ? content : aiEdit.baseline;
    void runRewrite(aiEdit.instruction, baseline);
  };

  // Run a schema-agnostic folio tracked-change command. onUpdate finalises the
  // review (re-enables editing, emits the body) once no changes remain.
  const runResolveCommand = (command: PMCommand) => {
    if (!isUsableEditor(editor)) {
      return;
    }
    setHunkMenu(null);
    editor.commands.command(({ state, dispatch }) => command(state, dispatch));
  };

  const acceptAll = () => runResolveCommand(acceptAllChanges());
  const rejectAll = () => runResolveCommand(rejectAllChanges());
  const acceptHunk = (revisionId: number) =>
    runResolveCommand(acceptAIEditRevision(revisionId));
  const rejectHunk = (revisionId: number) =>
    runResolveCommand(rejectAIEditRevision(revisionId));

  const toggleAiEdit = () => {
    if (aiEdit.status === "idle") {
      setAiEdit({ status: "prompting", instruction: "" });
      return;
    }
    // Closing while reviewing discards the suggestion (revert to baseline).
    if (aiEdit.status === "reviewing") {
      rejectAll();
      return;
    }
    setAiEdit({ status: "idle" });
  };

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

  const toggleBulletList = useCallback(() => {
    if (!isUsableEditor(editor)) {
      return;
    }

    editor.chain().focus().toggleBulletList().run();
  }, [editor]);

  const toggleOrderedList = useCallback(() => {
    if (!isUsableEditor(editor)) {
      return;
    }

    editor.chain().focus().toggleOrderedList().run();
  }, [editor]);

  const undo = useCallback(() => {
    if (!isUsableEditor(editor)) {
      return;
    }

    editor.chain().focus().undo().run();
  }, [editor]);

  const redo = useCallback(() => {
    if (!isUsableEditor(editor)) {
      return;
    }

    editor.chain().focus().redo().run();
  }, [editor]);

  const canUndo = editorReady && editor.can().undo();
  const canRedo = editorReady && editor.can().redo();
  const reviewing = aiEdit.status === "reviewing";
  const aiActive = aiEdit.status !== "idle";

  return (
    // Stop modifier key combos from propagating to global
    // hotkeys (e.g., Cmd+B toggles sidebar otherwise).
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- non-interactive editor wrapper; onKeyDown only stops modifier combos reaching global hotkeys, real input is the contenteditable inside
    <div
      className="clause-editor relative rounded-md border"
      onKeyDown={(e) => {
        if (e.metaKey || e.ctrlKey) {
          e.stopPropagation();
        }
      }}
      ref={containerRef}
    >
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 border-b px-1 py-0.5">
        <Button
          aria-label={t("folio.undo")}
          disabled={!canUndo || reviewing}
          onClick={undo}
          size="icon-xs"
          title={t("folio.undo")}
          type="button"
          variant="ghost"
        >
          <Undo2Icon className="size-3.5" />
        </Button>
        <Button
          aria-label={t("folio.redo")}
          disabled={!canRedo || reviewing}
          onClick={redo}
          size="icon-xs"
          title={t("folio.redo")}
          type="button"
          variant="ghost"
        >
          <Redo2Icon className="size-3.5" />
        </Button>
        <div className="bg-border mx-1 h-4 w-px" />
        <Button
          aria-label={t("folio.bold")}
          className={
            editorReady && editor.isActive("bold") ? "bg-muted" : undefined
          }
          disabled={!editorReady || reviewing}
          onClick={toggleBold}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <BoldIcon className="size-3.5" />
        </Button>
        <Button
          aria-label={t("folio.italic")}
          className={
            editorReady && editor.isActive("italic") ? "bg-muted" : undefined
          }
          disabled={!editorReady || reviewing}
          onClick={toggleItalic}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <ItalicIcon className="size-3.5" />
        </Button>
        <div className="bg-border mx-1 h-4 w-px" />
        <Button
          aria-label="H1"
          className={
            editorReady && editor.isActive("heading", { level: 1 })
              ? "bg-muted"
              : undefined
          }
          disabled={!editorReady || reviewing}
          onClick={() => toggleHeading(1)}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <Heading1Icon className="size-3.5" />
        </Button>
        <Button
          aria-label="H2"
          className={
            editorReady && editor.isActive("heading", { level: 2 })
              ? "bg-muted"
              : undefined
          }
          disabled={!editorReady || reviewing}
          onClick={() => toggleHeading(2)}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <Heading2Icon className="size-3.5" />
        </Button>
        <Button
          aria-label="H3"
          className={
            editorReady && editor.isActive("heading", { level: 3 })
              ? "bg-muted"
              : undefined
          }
          disabled={!editorReady || reviewing}
          onClick={() => toggleHeading(3)}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <Heading3Icon className="size-3.5" />
        </Button>
        <div className="bg-border mx-1 h-4 w-px" />
        <Button
          aria-label={t("folio.bulletList")}
          className={
            editorReady && editor.isActive("bulletList")
              ? "bg-muted"
              : undefined
          }
          disabled={!editorReady || reviewing}
          onClick={toggleBulletList}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <ListIcon className="size-3.5" />
        </Button>
        <Button
          aria-label={t("folio.numberedList")}
          className={
            editorReady && editor.isActive("orderedList")
              ? "bg-muted"
              : undefined
          }
          disabled={!editorReady || reviewing}
          onClick={toggleOrderedList}
          size="icon-xs"
          type="button"
          variant="ghost"
        >
          <ListOrderedIcon className="size-3.5" />
        </Button>

        <Button
          aria-label={t("ai.editWithAI")}
          className={cn("ms-auto", aiActive && "bg-muted")}
          disabled={!editorReady || aiEdit.status === "generating"}
          onClick={toggleAiEdit}
          size="icon-xs"
          title={t("ai.editWithAI")}
          type="button"
          variant="ghost"
        >
          <WandSparklesIcon className="size-3.5" />
        </Button>
      </div>

      {/* Editor area stays mounted during review; AI edits render inline as
          tracked changes rather than in a separate read-only diff pane. */}
      <EditorContent editor={editor} />

      {hunkMenu && reviewing ? (
        <HunkMenu
          onAccept={() => acceptHunk(hunkMenu.revisionId)}
          onReject={() => rejectHunk(hunkMenu.revisionId)}
          top={hunkMenu.top}
          left={hunkMenu.left}
        />
      ) : null}

      <p
        className={cn(
          "text-muted-foreground border-t px-2 py-1 text-xs",
          aiActive && "pb-16",
        )}
      >
        {t("clauses.formattingPreviewHint")}
      </p>

      {aiEdit.status === "idle" ? null : (
        <AiEditBar
          instruction={aiEdit.instruction}
          onAcceptAll={acceptAll}
          onCancel={toggleAiEdit}
          onInstructionChange={updateInstruction}
          onRejectAll={rejectAll}
          onSubmit={submitAiEdit}
          status={aiEdit.status}
        />
      )}
    </div>
  );
};

// ── Inline accept/reject menu for one tracked change ────

type HunkMenuProps = {
  top: number;
  left: number;
  onAccept: () => void;
  onReject: () => void;
};

const HunkMenu = ({ top, left, onAccept, onReject }: HunkMenuProps) => {
  const t = useTranslations();
  return (
    <div
      className="bg-popover absolute z-20 flex items-center gap-0.5 rounded-md border p-0.5 shadow-md"
      style={{ top, left }}
    >
      <Button
        aria-label={t("common.accept")}
        onClick={onAccept}
        size="icon-xs"
        title={t("common.accept")}
        type="button"
        variant="ghost"
      >
        <CheckIcon className="size-3.5" />
      </Button>
      <Button
        aria-label={t("docxReview.reject")}
        onClick={onReject}
        size="icon-xs"
        title={t("docxReview.reject")}
        type="button"
        variant="ghost"
      >
        <XIcon className="size-3.5" />
      </Button>
    </div>
  );
};

// ── AI edit bar ─────────────────────────────────────

type AiEditBarProps = {
  status: "prompting" | "generating" | "reviewing";
  instruction: string;
  onInstructionChange: (value: string) => void;
  onSubmit: () => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onCancel: () => void;
};

const AiEditBar = ({
  status,
  instruction,
  onInstructionChange,
  onSubmit,
  onAcceptAll,
  onRejectAll,
  onCancel,
}: AiEditBarProps) => {
  const t = useTranslations();
  const generating = status === "generating";
  const reviewing = status === "reviewing";

  return (
    <div className="bg-popover absolute inset-x-0 bottom-2 z-10 mx-auto flex w-[min(92%,32rem)] flex-col gap-2 rounded-lg border p-2 shadow-lg">
      <div className="flex items-start gap-2">
        <WandSparklesIcon className="text-muted-foreground mt-2 size-3.5 shrink-0" />
        <Textarea
          autoFocus
          className="min-h-9 flex-1 resize-none text-sm"
          disabled={generating}
          onChange={(e) => onInstructionChange(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              onSubmit();
            }
          }}
          placeholder={t("ai.refinePlaceholder")}
          value={instruction}
        />
      </div>
      <div className="flex items-center justify-end gap-2">
        {reviewing ? (
          <Button onClick={onRejectAll} size="sm" type="button" variant="ghost">
            <XIcon className="size-3.5" />
            {t("docxReview.rejectAll")}
          </Button>
        ) : (
          <Button onClick={onCancel} size="sm" type="button" variant="ghost">
            {t("common.cancel")}
          </Button>
        )}
        <Button
          disabled={generating || instruction.trim() === ""}
          onClick={onSubmit}
          size="sm"
          type="button"
          variant={reviewing ? "ghost" : undefined}
        >
          <AiEditSubmitIcon generating={generating} reviewing={reviewing} />
          {reviewing ? t("common.regenerate") : t("ai.editWithAI")}
        </Button>
        {reviewing ? (
          <Button onClick={onAcceptAll} size="sm" type="button">
            <CheckIcon className="size-3.5" />
            {t("docxReview.acceptAll")}
          </Button>
        ) : null}
      </div>
    </div>
  );
};

const AiEditSubmitIcon = ({
  generating,
  reviewing,
}: {
  generating: boolean;
  reviewing: boolean;
}) => {
  if (generating) {
    return <Loader2Icon className="size-3.5 animate-spin" />;
  }
  if (reviewing) {
    return <RotateCcwIcon className="size-3.5" />;
  }
  return <WandSparklesIcon className="size-3.5" />;
};

import { Mark, mergeAttributes } from "@tiptap/core";

/**
 * TipTap insertion/deletion marks for AI tracked changes in the clause editor.
 *
 * These mirror Folio's tracked-change mark schema (mark names `insertion` /
 * `deletion`, a numeric `revisionId`, plus `author`/`date`) so the schema-
 * agnostic accept/reject commands shared from `@stll/folio-core` resolve them
 * directly. Folio's own mark extensions can't be reused as-is: they are built
 * with Folio's bespoke extension system, not TipTap. Only this thin schema
 * shim is clause-local; the resolution logic comes from `@stll/folio-core`
 * and the word diff comes from `@stll/folio-react`.
 */

export const INSERTION_MARK = "insertion";
export const DELETION_MARK = "deletion";

type TrackedChangeAttrs = {
  revisionId: number;
  author: string;
  date: string | null;
};

const trackedChangeAttributes = () => ({
  revisionId: {
    default: 0,
    parseHTML: (el: HTMLElement) =>
      Number.parseInt(el.dataset["revisionId"] ?? "0", 10),
    renderHTML: (attrs: TrackedChangeAttrs) => ({
      "data-revision-id": String(attrs.revisionId),
    }),
  },
  author: {
    default: "",
    parseHTML: (el: HTMLElement) => el.dataset["author"] ?? "",
    renderHTML: (attrs: TrackedChangeAttrs) =>
      attrs.author ? { "data-author": attrs.author } : {},
  },
  date: {
    default: null,
    parseHTML: (el: HTMLElement) => el.dataset["date"] ?? null,
    renderHTML: (attrs: TrackedChangeAttrs) =>
      attrs.date ? { "data-date": attrs.date } : {},
  },
});

export const InsertionMark = Mark.create({
  name: INSERTION_MARK,
  inclusive: false,
  addAttributes: trackedChangeAttributes,
  parseHTML: () => [{ tag: "span.docx-insertion" }],
  renderHTML: ({ HTMLAttributes }) => [
    "span",
    mergeAttributes(HTMLAttributes, { class: "docx-insertion" }),
    0,
  ],
});

export const DeletionMark = Mark.create({
  name: DELETION_MARK,
  inclusive: false,
  addAttributes: trackedChangeAttributes,
  parseHTML: () => [{ tag: "span.docx-deletion" }],
  renderHTML: ({ HTMLAttributes }) => [
    "span",
    mergeAttributes(HTMLAttributes, { class: "docx-deletion" }),
    0,
  ],
});

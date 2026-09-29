import type { DragEvent } from "react";

import type { ContextMenuAction } from "@stll/ui/context-menu";

/**
 * A template as the shared views render it, whichever source supplied it.
 * Usage, authorship and edit times exist only for a library's own templates:
 * a source without them leaves them out, and the views show nothing in their
 * place rather than a zero or a made-up date.
 */
export type KnowledgeTemplate = {
  id: string;
  name: string;
  fieldCount: number;
  categoryId: string | null;
  tags: string[] | null;
  /** Ordered BCP-47 tags of the document text, primary language first. */
  languages: string[];
  whenToUse: string | null;
  whenNotToUse: string | null;
  updatedAt?: string | undefined;
  lastUsedAt?: string | null | undefined;
  useCount?: number | undefined;
  /** Present, even as `null`, when the source records who added the template. */
  authorName?: string | null | undefined;
  authorImage?: string | null | undefined;
};

type KnowledgeTemplateCategory = {
  id: string;
  name: string;
};

/** A template from a published catalogue, as its detail page shows it. */
export type KnowledgeCatalogueTemplate = {
  title: string;
  packName: string;
  license: string;
  licenseUrl: string | null;
  /** Country codes the template is drafted for. */
  jurisdictions: readonly string[];
  languages: readonly string[];
  legalArea: string | null;
  /** The names of the fields a filled copy asks for. */
  fields: readonly string[];
  disclaimer: string | null;
};

/** What the template list renders. The route's adapter fills it. */
export type TemplatesSource = {
  status: "loading" | "error" | "ready";
  templates: readonly KnowledgeTemplate[];
  categories: readonly KnowledgeTemplateCategory[];
  /** The category the list is narrowed to; `null` shows every template. */
  selectedCategoryId: string | null;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
};

/** What the template list can do. The route decides what each one means. */
export type TemplatesActions = {
  loadMore: () => void;
  /** Present when the viewer may add a template by dropping a file on the list. */
  dropFile?: ((file: File) => void) | undefined;
};

/** What one template row can do. An absent entry hides its control. */
export type TemplateRowActions = {
  /** The whole row opens the template. */
  open: () => void;
  /** The row's primary call to action. */
  use?: (() => void) | undefined;
  /** Edits the row's "when to use" line in place. */
  describe?: (() => void) | undefined;
  /** The ⋯ menu, also shown on right-click. */
  menu: ContextMenuAction[];
  /** Makes the row draggable, e.g. onto a category. */
  dragStart?: ((event: DragEvent) => void) | undefined;
};

/** The list's tag filter, handed to the filter slots. */
export type TemplateTagFilter = {
  tags: string[];
  selectedTag: string | null;
  selectTag: (tag: string | null) => void;
};

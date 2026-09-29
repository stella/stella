import type { DragEvent } from "react";

import type { ContextMenuAction } from "@stll/ui/context-menu";

/** A template as the shared views render it, whichever source supplied it. */
export type KnowledgeTemplate = {
  id: string;
  name: string;
  fileName: string;
  fieldCount: number;
  sizeBytes: number;
  categoryId: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  useCount: number;
  tags: string[] | null;
  /** Ordered BCP-47 tags of the document text, primary language first. */
  languages: string[];
  whenToUse: string | null;
  whenNotToUse: string | null;
  authorName: string | null;
  authorImage: string | null;
};

type KnowledgeTemplateCategory = {
  id: string;
  name: string;
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

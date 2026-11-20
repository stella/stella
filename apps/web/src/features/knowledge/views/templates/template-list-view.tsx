import type { DragEvent, ReactElement, ReactNode } from "react";
import { useState } from "react";

import { useTranslations } from "use-intl";

import { compareByLocale } from "@stll/collation";
import { Button } from "@stll/ui/button";
import { XIcon } from "@stll/ui/icons";
import { SegmentedIconToggle } from "@stll/ui/segmented-icon-toggle";

import type {
  KnowledgeActions,
  KnowledgeSource,
} from "@/features/knowledge/views/knowledge-seam";
import { KnowledgeStatusMessage } from "@/features/knowledge/views/knowledge-status-message";
import {
  TEMPLATE_DENSITY_OPTIONS,
  TEMPLATE_LIST_LAYOUT,
  TEMPLATE_TOOLBAR_CLASS,
  TemplateListPending,
} from "@/features/knowledge/views/templates/template-list-shape";
import type { TemplateListLayout } from "@/features/knowledge/views/templates/template-list-shape";
import type {
  KnowledgeTemplate,
  TemplateDensity,
  TemplateTagFilter,
} from "@/features/knowledge/views/templates/templates-seam";
import { useFormatter } from "@/i18n/formatting-context";
import { useI18nStore } from "@/i18n/i18n-store";
import { usePresentationPrefs } from "@/lib/account/presentation-prefs/provider";
import { optionalArray } from "@/lib/arrays";

/** The per-row context a route needs to render one row of the list. */
type TemplateRowContext = {
  allTags: string[];
  density: TemplateDensity;
};

type TemplateListViewProps = {
  source: KnowledgeSource<"templates">;
  actions: KnowledgeActions<"templates">;
  /** Renders one row, normally a `TemplateRowView` with the route's actions. */
  renderRow: (
    template: KnowledgeTemplate,
    row: TemplateRowContext,
  ) => ReactElement | null;
  /** Shown instead of the list when there is nothing to list and no filter. */
  emptyState?: ReactElement | undefined;
  /** Desktop navigation beside the list. */
  sidebar?: ((filter: TemplateTagFilter) => ReactNode) | undefined;
  /** Filters above the list on narrow screens. */
  mobileFilters?: ((filter: TemplateTagFilter) => ReactNode) | undefined;
  /** Controls at the end of the list header. */
  toolbar?: ReactNode;
  /** A tab after the list title, e.g. to switch to another catalogue. */
  catalogueTab?: ReactNode;
  /** A note above the rows. */
  teaser?: ReactNode;
  /** Dialogs the route owns, rendered inside the list. */
  children?: ReactNode;
};

// Only the file-drop affordance — NOT the internal template-row drag (which
// carries its own MIME type, not files) — should light up the list.
const isFileDrag = (e: DragEvent) => e.dataTransfer.types.includes("Files");

const TemplateListView = ({
  source,
  actions,
  renderRow,
  emptyState,
  sidebar,
  mobileFilters,
  toolbar,
  catalogueTab,
  teaser,
  children,
}: TemplateListViewProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const lang = useI18nStore((s) => s.lang);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const {
    prefs: { templateDensity: density },
    setPrefs,
  } = usePresentationPrefs();
  const { templates, selectedCategoryId } = source;
  const { dropFile } = actions;

  const changeDensity = (next: TemplateDensity) => {
    setPrefs(() => ({ templateDensity: next }));
  };

  const handleDragOver = (e: DragEvent) => {
    if (!dropFile || !isFileDrag(e)) {
      return;
    }
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e: DragEvent) => {
    if (!isFileDrag(e)) {
      return;
    }
    e.preventDefault();
    setIsDragOver(false);
    if (!dropFile) {
      return;
    }
    const file = e.dataTransfer.files.item(0);
    if (!file) {
      return;
    }
    dropFile(file);
  };

  if (templates.length === 0 && !selectedCategoryId) {
    return emptyState ?? null;
  }

  const allTags = [
    ...new Set(templates.flatMap((template) => optionalArray(template.tags))),
  ].toSorted(compareByLocale(lang));

  const visibleTemplates = tagFilter
    ? templates.filter((template) => template.tags?.includes(tagFilter))
    : templates;

  const filter: TemplateTagFilter = {
    tags: allTags,
    selectedTag: tagFilter,
    selectTag: setTagFilter,
  };

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col md:flex-row"
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="border-foreground/30 bg-background/80 pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-xl border-2 border-dashed opacity-100 transition-opacity">
          <p className="text-foreground text-sm font-medium">
            {t("templates.dropToCreate")}
          </p>
        </div>
      )}

      {sidebar && <div className="hidden md:contents">{sidebar(filter)}</div>}

      <div className="flex min-h-0 flex-1 flex-col md:border-s">
        <div className={TEMPLATE_TOOLBAR_CLASS}>
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="text-foreground text-sm font-semibold">
              {t("knowledge.sections.templates.title")}
            </h2>
            <span className="text-muted-foreground text-sm tabular-nums">
              {format.number(visibleTemplates.length)}
            </span>
            {tagFilter && (
              <span className="bg-muted text-foreground flex items-center gap-1 rounded-full py-0.5 ps-2 pe-1 text-xs font-medium">
                {tagFilter}
                <Button
                  aria-label={t("common.remove")}
                  className="group/plain"
                  onClick={() => setTagFilter(null)}
                  tooltip={t("common.remove")}
                  variant="plain"
                >
                  <span className="text-muted-foreground group-hover/plain:text-foreground flex rounded-full p-0.5">
                    <XIcon className="size-3" />
                  </span>
                </Button>
              </span>
            )}
            {catalogueTab}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <DensityToggle density={density} onChange={changeDensity} />
            {toolbar}
          </div>
        </div>

        {mobileFilters?.(filter)}

        <div className="flex-1 overflow-y-auto">
          {teaser}
          {visibleTemplates.length === 0 && (
            <div className="flex items-center justify-center p-8">
              <p className="text-muted-foreground text-sm">
                {t("templates.noTemplates")}
              </p>
            </div>
          )}

          <ul className="divide-y">
            {visibleTemplates.map((template) =>
              renderRow(template, { allTags, density }),
            )}
          </ul>

          {source.hasNextPage && (
            <div className="border-t p-1">
              <Button
                className="w-full"
                disabled={source.isFetchingNextPage}
                onClick={actions.loadMore}
                size="sm"
                variant="muted"
              >
                {t("common.loadMore")}
              </Button>
            </div>
          )}
        </div>
      </div>

      {children}
    </div>
  );
};

const DENSITY_LABEL_KEYS = {
  compact: "common.compact",
  comfortable: "common.comfortable",
} as const satisfies Record<TemplateDensity, string>;

type DensityToggleProps = {
  density: TemplateDensity;
  onChange: (density: TemplateDensity) => void;
};

const DensityToggle = ({ density, onChange }: DensityToggleProps) => {
  const t = useTranslations();

  return (
    <SegmentedIconToggle
      onChange={onChange}
      options={TEMPLATE_DENSITY_OPTIONS.map((option) => ({
        ...option,
        label: t(DENSITY_LABEL_KEYS[option.value]),
      }))}
      value={density}
    />
  );
};

// The list's pending phase at the reader's density: the presentation cookie
// gives it, so the server and the hydrating browser agree.
const TemplateListSkeleton = ({
  canCreate,
  layout,
}: {
  canCreate: boolean;
  layout: TemplateListLayout;
}) => {
  const {
    prefs: { templateDensity: density },
  } = usePresentationPrefs();
  return (
    <TemplateListPending
      canCreate={canCreate}
      density={density}
      layout={layout}
    />
  );
};

/**
 * The template library as one view: a skeleton while the source loads, a
 * message when it fails, then the list.
 */
export const TemplateLibraryView = (props: TemplateListViewProps) => {
  const t = useTranslations();

  if (props.source.status === "loading") {
    return (
      <TemplateListSkeleton
        // The library's toolbar is its create action, there when the member
        // may create.
        canCreate={Boolean(props.toolbar)}
        layout={
          props.sidebar === undefined
            ? TEMPLATE_LIST_LAYOUT.catalogue
            : TEMPLATE_LIST_LAYOUT.library
        }
      />
    );
  }
  if (props.source.status === "error") {
    return (
      <KnowledgeStatusMessage>
        {t("templates.loadFailed")}
      </KnowledgeStatusMessage>
    );
  }
  return <TemplateListView {...props} />;
};

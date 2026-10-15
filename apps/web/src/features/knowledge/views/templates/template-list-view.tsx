import type { DragEvent, ReactElement, ReactNode } from "react";
import { useState } from "react";

import { useTranslations } from "use-intl";

import { compareByLocale } from "@stll/collation";
import { Button } from "@stll/ui/button";
import { Rows2Icon, Rows3Icon, XIcon } from "@stll/ui/icons";
import { SegmentedIconToggle } from "@stll/ui/segmented-icon-toggle";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import Tooltip from "@/components/tooltip";
import type {
  KnowledgeActions,
  KnowledgeSource,
} from "@/features/knowledge/views/knowledge-seam";
import { KnowledgeStatusMessage } from "@/features/knowledge/views/knowledge-status-message";
import type { TemplateDensity } from "@/features/knowledge/views/templates/template-row-view";
import type {
  KnowledgeTemplate,
  TemplateTagFilter,
} from "@/features/knowledge/views/templates/templates-seam";
import { useFormatter } from "@/i18n/formatting-context";
import { useI18nStore } from "@/i18n/i18n-store";
import { deviceStorage } from "@/lib/account/browser-storage";
import { optionalArray } from "@/lib/arrays";
import { TOOLBAR_ROW_MIN_HEIGHT } from "@/lib/consts";

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

const DENSITY_STORAGE_KEY = "stella.templates.density";

/** Persisted list density; defaults to compact for fast scanning. */
const readTemplateDensity = (): TemplateDensity =>
  deviceStorage("local").getItem(DENSITY_STORAGE_KEY) === "comfortable"
    ? "comfortable"
    : "compact";

const writeTemplateDensity = (density: TemplateDensity): void => {
  deviceStorage("local").setItem(DENSITY_STORAGE_KEY, density);
};

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
  const [density, setDensity] = useState<TemplateDensity>(readTemplateDensity);
  const { templates, selectedCategoryId } = source;
  const { dropFile } = actions;

  const changeDensity = (next: TemplateDensity) => {
    setDensity(next);
    writeTemplateDensity(next);
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
        <div
          className={cn(
            "flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2 md:py-0",
            TOOLBAR_ROW_MIN_HEIGHT,
          )}
        >
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
                <Tooltip
                  content={t("common.remove")}
                  render={
                    <button
                      aria-label={t("common.remove")}
                      className="text-muted-foreground hover:text-foreground rounded-full p-0.5"
                      onClick={() => setTagFilter(null)}
                      type="button"
                    />
                  }
                >
                  <XIcon className="size-3" />
                </Tooltip>
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

type DensityToggleProps = {
  density: TemplateDensity;
  onChange: (density: TemplateDensity) => void;
};

const DensityToggle = ({ density, onChange }: DensityToggleProps) => {
  const t = useTranslations();

  return (
    <SegmentedIconToggle
      onChange={onChange}
      options={[
        { value: "compact", icon: Rows3Icon, label: t("common.compact") },
        {
          value: "comfortable",
          icon: Rows2Icon,
          label: t("common.comfortable"),
        },
      ]}
      value={density}
    />
  );
};

const TEMPLATE_SIDEBAR_KEYS = ["a", "b", "c", "d", "e"];
const TEMPLATE_ROW_KEYS = ["a", "b", "c", "d", "e", "f"];

// Mirrors the TemplateListView layout (w-48 category sidebar + bordered list
// pane with count/new-template toolbar and divided rows) so the page keeps its
// shape while templates load; only the values fade in.
export const TemplateListSkeleton = () => (
  <div className="flex min-h-0 flex-1">
    <div className="flex w-48 shrink-0 flex-col overflow-y-auto">
      <nav className="flex-1 space-y-1 p-2">
        <Skeleton className="h-7 w-full rounded-md" />
        <div className="my-1 border-t" />
        {TEMPLATE_SIDEBAR_KEYS.map((key) => (
          <Skeleton className="h-7 w-2/3 rounded-md" key={key} />
        ))}
      </nav>
    </div>

    <div className="flex min-h-0 flex-1 flex-col border-s">
      <div className="flex items-center justify-between border-b px-4 py-2">
        <Skeleton className="h-4 w-8" />
        <Skeleton className="h-8 w-32 rounded-md" />
      </div>

      <ul className="flex-1 divide-y overflow-y-auto">
        {TEMPLATE_ROW_KEYS.map((key) => (
          <li className="flex items-center gap-4 px-4 py-3" key={key}>
            <Skeleton className="size-9 shrink-0 rounded-lg" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-32" />
            </div>
          </li>
        ))}
      </ul>
    </div>
  </div>
);

/**
 * The template library as one view: a skeleton while the source loads, a
 * message when it fails, then the list.
 */
export const TemplateLibraryView = (props: TemplateListViewProps) => {
  const t = useTranslations();

  if (props.source.status === "loading") {
    return <TemplateListSkeleton />;
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

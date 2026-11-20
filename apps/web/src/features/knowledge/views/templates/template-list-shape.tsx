// The template list's shape: light presentational pieces only (a
// pending-safe module, see .oxlint-plugins/route-pending-component-policy.json),
// so the pending views draw them before any provider mounts.

import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";
import type { TemplateDensity } from "@/features/knowledge/views/templates/templates-seam";

/** A template row's padding and alignment, per density. */
export const TEMPLATE_ROW_SPACING = {
  compact: "items-center py-2",
  comfortable: "items-start py-3",
} as const satisfies Record<TemplateDensity, string>;

// The list's toolbar row; `min-h-12` is the app's toolbar row height
// (`TOOLBAR_ROW_MIN_HEIGHT`), written out so this module stays this light.
export const TEMPLATE_TOOLBAR_CLASS =
  "flex min-h-12 flex-wrap items-center justify-between gap-2 border-b px-4 py-2 md:py-0";

/**
 * Which chrome a loaded list renders: the member library's category sidebar,
 * mobile filter row and toolbar, or the public catalogue's bare list.
 */
export const TEMPLATE_LIST_LAYOUT = {
  library: "library",
  catalogue: "catalogue",
} as const;
export type TemplateListLayout =
  (typeof TEMPLATE_LIST_LAYOUT)[keyof typeof TEMPLATE_LIST_LAYOUT];

const TEMPLATE_SIDEBAR_KEYS = ["a", "b", "c", "d", "e"];
const TEMPLATE_ROW_KEYS = ["a", "b", "c", "d", "e", "f"];

// Mirrors the template list (w-48 category sidebar + bordered list pane with
// count/new-template toolbar and divided rows) so the page keeps its shape
// while templates load; only the values fade in. The caller passes the
// density: the loaded list's reads the presentation preference, a route's
// pending view (drawn before any provider) the default.
export const TemplateListPending = ({
  density = "compact",
  layout,
}: {
  density?: TemplateDensity | undefined;
  layout: TemplateListLayout;
}) => {
  const hasLibraryChrome = layout === TEMPLATE_LIST_LAYOUT.library;
  return (
    <div
      aria-hidden="true"
      className="flex min-h-0 flex-1 flex-col md:flex-row"
    >
      {hasLibraryChrome && (
        <div className="hidden w-48 shrink-0 flex-col md:flex">
          <nav className="flex-1 space-y-1 p-2">
            <Skeleton className="h-7 w-full rounded-md" />
            <div className="my-1 border-t" />
            {TEMPLATE_SIDEBAR_KEYS.map((key) => (
              <Skeleton className="h-7 w-2/3 rounded-md" key={key} />
            ))}
          </nav>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col md:border-s">
        <div className={TEMPLATE_TOOLBAR_CLASS}>
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="text-foreground text-sm font-semibold">
              <PendingText
                barClassName="w-20"
                id="knowledge.sections.templates.title"
              />
            </h2>
            <Skeleton className="h-4 w-4" />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Skeleton className="h-8 w-16 rounded-md" />
            {hasLibraryChrome && <Skeleton className="h-8 w-32 rounded-md" />}
          </div>
        </div>

        {hasLibraryChrome && (
          <div className="border-b px-3 py-2 md:hidden">
            <div className="flex gap-1 pb-0.5">
              <Skeleton className="h-8 w-32" />
            </div>
          </div>
        )}
        {/* A placeholder of the list's geometry: nothing in it scrolls. */}
        <ul className="flex-1 divide-y overflow-hidden">
          {TEMPLATE_ROW_KEYS.map((key) => (
            <li
              className={cn("flex gap-3 px-4", TEMPLATE_ROW_SPACING[density])}
              key={key}
            >
              <Skeleton className="size-9 shrink-0 rounded-lg" />
              <div
                className={cn(
                  "flex min-w-0 flex-1 gap-2",
                  density === "compact" ? "items-baseline" : "flex-col gap-1",
                )}
              >
                <Skeleton
                  className={cn(
                    "w-48 max-w-full",
                    density === "compact" ? "h-5" : "h-6",
                  )}
                />
                {/* The category, and in comfortable rows the guidance line:
                    catalogue rows carry neither, so they never render it. */}
                {hasLibraryChrome && (
                  <Skeleton className="h-4 w-32 max-w-full" />
                )}
                {density === "comfortable" && (
                  <Skeleton className="h-4 w-40 max-w-full" />
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

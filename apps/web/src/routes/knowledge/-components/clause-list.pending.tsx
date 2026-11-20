import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending, InputFace } from "@stll/ui/control-face";
import {
  DownloadIcon,
  PlusIcon,
  TextQuoteIcon,
  UploadIcon,
} from "@stll/ui/icons";
import { cn } from "@stll/ui/utils";
import {
  ResponsiveActionToolbar,
  ResponsiveActionToolbarItem,
} from "@stll/workspace-ui/responsive-action-toolbar";

import { PendingText } from "@/components/pending-text";
import {
  CategoryMobileFilterBarPending,
  CategorySidebarPending,
} from "@/features/knowledge/views/category-sidebar.pending";

/*
 * The clause library's shape (./clause-list.tsx): the category sidebar, the
 * search and actions bar, the mobile filters and the rows, with no
 * behaviour, so its loading view draws the page it stands in for before any
 * provider mounts.
 */

type ClauseListShellProps = {
  /** The category sidebar, shown from `md` up. */
  sidebar: ReactNode;
  /** The search field, which takes the bar's free width. */
  search: ReactNode;
  /** The import, export and create actions at the bar's end. */
  actions: ReactNode;
  /** The category filters below `md`. */
  filters: ReactNode;
  /** The list, and what opens over it. */
  children: ReactNode;
};

/** The clause library's layout, drawn by both phases. */
export const ClauseListShell = ({
  actions,
  children,
  filters,
  search,
  sidebar,
}: ClauseListShellProps) => (
  <div className="flex min-h-0 flex-1 flex-col md:flex-row">
    <div className="hidden md:contents">{sidebar}</div>
    <div className="flex min-h-0 flex-1 flex-col md:border-s">
      <div className="border-b px-4 py-2" data-slot="clause-list-toolbar">
        <ResponsiveActionToolbar>
          <ResponsiveActionToolbarItem slot="primary">
            {search}
          </ResponsiveActionToolbarItem>
          <ResponsiveActionToolbarItem slot="action">
            <div className="flex gap-1">{actions}</div>
          </ResponsiveActionToolbarItem>
        </ResponsiveActionToolbar>
      </div>
      {filters}
      {children}
    </div>
  </div>
);

/** A clause row: its tile, title, the category and date line, and the
 *  version at its end. */
export const ClauseRowBody = ({
  className,
  meta,
  title,
  trailing,
}: {
  className?: string | undefined;
  meta: ReactNode;
  title: ReactNode;
  trailing: ReactNode;
}) => (
  <span
    className={cn(
      "flex w-full items-center gap-3 px-4 py-3 text-start",
      className,
    )}
  >
    <span className="bg-muted flex size-9 shrink-0 items-center justify-center rounded-lg">
      <TextQuoteIcon className="text-muted-foreground size-4" />
    </span>
    <span className="flex min-w-0 flex-1 flex-col">
      {title}
      <span className="text-muted-foreground text-xs">{meta}</span>
    </span>
    <span className="text-muted-foreground shrink-0 text-xs">{trailing}</span>
  </span>
);

const ROW_KEYS = ["a", "b", "c", "d", "e", "f", "g", "h"];
const TITLE_WIDTHS = ["w-48", "w-40", "w-56", "w-36"];

/** The clause library while it loads: the bar's search field and the
 *  actions the member's role gets, and placeholder rows. */
export const ClauseListPending = ({ canCreate }: { canCreate: boolean }) => {
  const allLabel = <PendingText barClassName="w-16" id="clauses.allClauses" />;
  return (
    <ClauseListShell
      actions={
        <>
          {canCreate && (
            <ButtonFace size="sm" variant="outline">
              <UploadIcon />
              <span className="hidden sm:inline">
                <PendingText barClassName="w-12" id="common.import" />
              </span>
            </ButtonFace>
          )}
          <ButtonFace size="sm" variant="outline">
            <DownloadIcon />
            <span className="hidden sm:inline">
              <PendingText barClassName="w-12" id="clauses.export" />
            </span>
          </ButtonFace>
          {canCreate && (
            <ButtonFace size="sm" variant="default">
              <PlusIcon />
              <span className="hidden sm:inline">
                <PendingText barClassName="w-20" id="clauses.createClause" />
              </span>
            </ButtonFace>
          )}
        </>
      }
      filters={
        <CategoryMobileFilterBarPending
          allLabel={allLabel}
          canCreate={canCreate}
          selection="all"
        />
      }
      search={
        <InputFace
          className="min-h-11 sm:min-h-0"
          fieldClassName="max-sm:h-11"
          size="sm"
        >
          <PendingText barClassName="w-32" id="clauses.searchPlaceholder" />
        </InputFace>
      }
      sidebar={
        <CategorySidebarPending
          allLabel={allLabel}
          canCreate={canCreate}
          selection="all"
        />
      }
    >
      <div className="flex-1 overflow-hidden" data-slot="clause-list-body">
        <ul
          aria-hidden="true"
          className="divide-y"
          data-slot="clause-rows-pending"
        >
          {ROW_KEYS.map((key, index) => (
            <li key={key}>
              <ClauseRowBody
                meta={<FaceLabelPending className="w-32" />}
                title={
                  <span className="text-sm">
                    <FaceLabelPending
                      className={cn(TITLE_WIDTHS[index % TITLE_WIDTHS.length])}
                    />
                  </span>
                }
                trailing={<FaceLabelPending className="w-8" />}
              />
            </li>
          ))}
        </ul>
      </div>
    </ClauseListShell>
  );
};

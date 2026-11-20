import type { ReactNode } from "react";

import { FaceLabelPending, InputFace } from "@stll/ui/control-face";
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
import {
  ActionFace,
  KnowledgeRowBody,
  KnowledgeRowsPending,
  RowTitlePending,
} from "@/features/knowledge/views/knowledge-list.pending";

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
  <KnowledgeRowBody
    className={cn("w-full px-4 py-3 text-start", className)}
    icon={TextQuoteIcon}
    meta={meta}
    title={title}
    trailing={
      <span className="text-muted-foreground shrink-0 text-xs">{trailing}</span>
    }
  />
);

/** The clause library while it loads: the bar's search field and the
 *  actions the member's role gets, and placeholder rows. */
export const ClauseListPending = ({ canCreate }: { canCreate: boolean }) => {
  const allLabel = <PendingText barClassName="w-16" id="clauses.allClauses" />;
  return (
    <ClauseListShell
      actions={
        <>
          {canCreate && (
            <ActionFace
              icon={<UploadIcon />}
              label="common.import"
              labelFromSm
              variant="outline"
              width="w-12"
            />
          )}
          <ActionFace
            icon={<DownloadIcon />}
            label="clauses.export"
            labelFromSm
            variant="outline"
            width="w-12"
          />
          {canCreate && (
            <ActionFace
              icon={<PlusIcon />}
              label="clauses.createClause"
              labelFromSm
              variant="default"
              width="w-20"
            />
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
        <KnowledgeRowsPending
          count={8}
          row={(index) => (
            <li key={index}>
              <ClauseRowBody
                meta={<FaceLabelPending className="w-32" />}
                title={<RowTitlePending index={index} />}
                trailing={<FaceLabelPending className="w-8" />}
              />
            </li>
          )}
        />
      </div>
    </ClauseListShell>
  );
};

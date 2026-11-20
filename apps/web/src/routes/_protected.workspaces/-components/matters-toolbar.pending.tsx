import type { ReactNode } from "react";

import { ButtonFace, FaceLabelPending, InputFace } from "@stll/ui/control-face";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  LayoutGridIcon,
  ListIcon,
  PlusIcon,
  SearchIcon,
  SlidersHorizontalIcon,
} from "@stll/ui/icons";
import { TOOLBAR_ROW_HEIGHT } from "@stll/ui/layout-tokens";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";
import type { MattersSortKey } from "@/lib/workspaces/types";
import { MATTERS_SORT_LABEL_KEYS } from "@/routes/_protected.workspaces/-hooks/matters-labels.logic";

/** The search field's share of the toolbar row. */
export const MATTERS_SEARCH_FIELD_CLASS =
  "min-w-0 flex-1 sm:w-64 sm:max-w-[40%] sm:flex-none";

type MattersToolbarShellProps = {
  search: ReactNode;
  /** The active or archived matters. */
  status: ReactNode;
  sort: ReactNode;
  /** The grid or table toggle. */
  layout: ReactNode;
  /** "New matter", at the row's end, or nothing. */
  create: ReactNode;
};

/**
 * The matters toolbar's one layout, drawn by both phases: the search field,
 * the status choice, a rule, the sort menu and the layout toggle, and the
 * create button at the end. The loaded toolbar fills it with the live
 * controls; the loading view with their faces.
 */
export const MattersToolbarShell = ({
  create,
  layout,
  search,
  sort,
  status,
}: MattersToolbarShellProps) => (
  <div
    className={cn("flex items-center gap-1 border-b px-2", TOOLBAR_ROW_HEIGHT)}
    data-slot="matters-toolbar"
  >
    {search}
    {status}
    <span aria-hidden="true" className="bg-border mx-1 h-4 w-px shrink-0" />
    {sort}
    {layout}
    <div className="ms-auto flex items-center gap-1">{create}</div>
  </div>
);

/**
 * The sort chip's content: the glyph, the sort's name (from `sm`) and its
 * direction. `label` and `direction` are a bar until the sort is read.
 */
export const MattersSortChipContent = ({
  direction,
  label,
}: {
  label: ReactNode;
  direction: ReactNode;
}) => (
  <>
    <SlidersHorizontalIcon />
    <span className="text-muted-foreground hidden text-xs sm:inline">
      {label}
    </span>
    {direction}
  </>
);

/** The arrow for the sort's direction. */
export const MattersSortDirectionIcon = ({ desc }: { desc: boolean }) =>
  desc ? (
    <ArrowDownIcon className="size-3" />
  ) : (
    <ArrowUpIcon className="size-3" />
  );

/** The layout toggle's content: the layout it switches to, glyph and name. */
export const MattersLayoutToggleContent = ({
  icon,
  label,
}: {
  icon: ReactNode;
  label: ReactNode;
}) => (
  <>
    {icon}
    <span className="hidden sm:inline">{label}</span>
  </>
);

/** The create button's content: the glyph, and its name from `sm`. */
export const MattersCreateContent = ({ label }: { label: ReactNode }) => (
  <>
    <PlusIcon />
    <span className="hidden sm:inline">{label}</span>
  </>
);

type MattersToolbarFaceProps = {
  /** The status the address names. */
  archived: boolean;
  /**
   * The member's toolbar settings, `undefined` while this browser's copy is
   * not read yet (the server's paint and the hydration pass): bars stand
   * where the sort and the layout go.
   */
  config:
    | {
        sortKey: MattersSortKey;
        sortDesc: boolean;
        viewMode: "grid" | "table";
      }
    | undefined;
  /** Whether the loaded toolbar will offer "New matter". */
  canCreate: boolean;
};

/**
 * The matters toolbar before the page has loaded: every control in its face,
 * at its place in the row.
 */
export const MattersToolbarFace = ({
  archived,
  canCreate,
  config,
}: MattersToolbarFaceProps) => (
  <MattersToolbarShell
    create={
      canCreate ? (
        <ButtonFace size="xs" variant="default">
          <MattersCreateContent
            label={<PendingText barClassName="w-16" id="common.newMatter" />}
          />
        </ButtonFace>
      ) : null
    }
    layout={
      <ButtonFace size="xs" variant="ghost">
        {config === undefined ? (
          <MattersLayoutToggleContent
            icon={<FaceLabelPending className="w-3.5" />}
            label={<FaceLabelPending className="w-10" />}
          />
        ) : (
          <MattersLayoutToggleContent
            icon={
              config.viewMode === "grid" ? <ListIcon /> : <LayoutGridIcon />
            }
            label={
              <PendingText
                barClassName="w-10"
                id={
                  config.viewMode === "grid"
                    ? "workspaces.views.layouts.table"
                    : "workspaces.views.layouts.grid"
                }
              />
            }
          />
        )}
      </ButtonFace>
    }
    search={
      <InputFace
        className={cn("min-h-11 sm:min-h-0", MATTERS_SEARCH_FIELD_CLASS)}
        fieldClassName="max-sm:h-11 max-sm:leading-11"
        icon={<SearchIcon />}
        size="sm"
      >
        <PendingText barClassName="w-16" id="common.search" />
      </InputFace>
    }
    sort={
      <ButtonFace size="xs" variant="ghost">
        <MattersSortChipContent
          direction={
            config === undefined ? (
              <FaceLabelPending className="w-3" />
            ) : (
              <MattersSortDirectionIcon desc={config.sortDesc} />
            )
          }
          label={
            config === undefined ? (
              <FaceLabelPending className="w-14" />
            ) : (
              <PendingText
                barClassName="w-14"
                id={MATTERS_SORT_LABEL_KEYS[config.sortKey]}
              />
            )
          }
        />
      </ButtonFace>
    }
    status={
      <ButtonFace size="xs" variant="ghost">
        <PendingText
          barClassName="w-12"
          id={archived ? "memory.views.archived" : "common.active"}
        />
      </ButtonFace>
    }
  />
);

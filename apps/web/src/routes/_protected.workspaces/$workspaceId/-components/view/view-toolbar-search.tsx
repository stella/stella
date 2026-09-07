import { useCallback, useId, useRef, useState } from "react";
import type { RefObject } from "react";

import { Columns3Icon, InfoIcon, SearchIcon, XIcon } from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import { ENTITY_FIND_TERM_MIN_LENGTH } from "@stll/api-contract";
import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { cn } from "@stll/ui/utils";

import { PropertyIcon } from "@/components/workspaces/property-helpers";
import { useFindSurface } from "@/lib/find-owner";
import type { WorkspaceProperty, WorkspaceView } from "@/lib/types";
import { useWorkspaceTableSchema } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-columns";
import {
  searchableColumnIds,
  toggleFindColumn,
  toPickerFindColumns,
} from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-find.logic";
import type { TableFindColumn } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-find.logic";
import { useTableStore } from "@/routes/_protected.workspaces/$workspaceId/-hooks/table-store";
import type { TableFindSelection } from "@/routes/_protected.workspaces/$workspaceId/-hooks/table-store";
import { useTableFind } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-table-find";

// The band every server-backed search in this app types at (the global search
// dialog and its facets): short enough to feel live, long enough that a typed
// word is one query rather than five.
const FIND_DEBOUNCE_MS = 250;

type ViewToolbarSearchProps = {
  /** The view pane, toolbar and grid: what a key press inside belongs to. */
  paneRef: RefObject<HTMLElement | null>;
  properties: WorkspaceProperty[];
  view: WorkspaceView<"table">;
};

/**
 * Find-in-table: the toolbar half. It owns the term and the column scope; the
 * table layouts read both from the store and turn them into row queries.
 *
 * The bar is an editor for a find that outlives it. Once a term is submitted
 * the control becomes a chip naming it, the way a filter or a sort does, so
 * the rows that stay narrowed after the popover closes are still explained.
 */
export const ViewToolbarSearch = ({
  paneRef,
  properties,
  view,
}: ViewToolbarSearchProps) => {
  const t = useTranslations();
  const { columns, request, selection } = useTableFind({ properties, view });
  // The picker also lists the metadata columns, disabled. They are read off the
  // rendered schema so the list cannot drift from the grid.
  const schema = useWorkspaceTableSchema({ properties, view });
  const pickerColumns = toPickerFindColumns({
    findColumns: columns,
    schemaColumns: schema.columns,
  });
  const find = useTableStore((state) => state.find[view.id]);
  const openFind = useTableStore((state) => state.openFind);
  const closeFind = useTableStore((state) => state.closeFind);
  const clearFind = useTableStore((state) => state.clearFind);
  const setFindTyped = useTableStore((state) => state.setFindTyped);
  const submitFind = useTableStore((state) => state.submitFind);
  const setFindScope = useTableStore((state) => state.setFindScope);
  const inputRef = useRef<HTMLInputElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  // The column picker lives inside this popover rather than in a menu of its
  // own: a nested popup counts as an outside press and closed the bar.
  //
  // Which view it is unfolded for, rather than whether it is unfolded: this
  // component stays mounted across a switch between two table views, so a
  // bare boolean would follow the reader and open the next view's picker
  // already expanded.
  const [columnsShownFor, setColumnsShownFor] = useState<string | null>(null);
  const columnsShown = columnsShownFor === view.id;

  // Debounced rather than immediate: `submit` is what turns a keystroke into
  // a row query, so it is the only path from `typed` to `submitted`.
  //
  // The view rides in as an argument rather than a closure. This component
  // stays mounted across a switch between two table views, so a timer
  // scheduled in one can fire under the other, and the term belongs to the
  // view it was typed into.
  const submit = useDebouncedCallback((viewId: string) => {
    submitFind(viewId);
  }, FIND_DEBOUNCE_MS);

  // The pane is the root, not this button: a press with a grid cell focused
  // has to count as inside the table, or a docked inspector takes it. The
  // popup is portaled, so it is named separately.
  useFindSurface({
    bar: popupRef,
    enabled: true,
    onFind: () => {
      openFind(view.id);
      inputRef.current?.focus();
    },
    owner: "table",
    root: paneRef,
    scope: "app",
  });

  const searchable = searchableColumnIds(columns);
  const narrowed = selection.type === "columns";
  const open = find?.status === "open";
  // Under the floor nothing is sent, so the rows stay put while the reader
  // types; the hint is what tells them the bar is waiting rather than broken.
  const typedLength = (find?.typed ?? "").trim().length;
  const tooShort = typedLength > 0 && typedLength < ENTITY_FIND_TERM_MIN_LENGTH;
  const tooShortHintId = useId();

  // What the rows on screen were asked for, so the chip cannot name a term
  // the query has not been sent; the selection it shows resolved in the same
  // pass as the request.
  const applied = request.find;

  // Reopening on a term means "search again", so the next keystroke replaces
  // it. `autoFocus` puts the caret in, it does not select what is there.
  //
  // Selecting from the ref callback rather than an effect keyed on `open`: the
  // popup mounts on the commit that opens it, so `inputRef.current` is still
  // null when such an effect runs and the selection is lost to the race. The
  // callback runs exactly when the node attaches, which is the moment there is
  // something to select. Its identity has to be stable: React detaches and
  // reattaches a ref callback that changes, which would re-select the term
  // under a caret the reader had placed mid-word.
  const bindInput = useCallback((node: HTMLInputElement | null) => {
    inputRef.current = node;
    node?.select();
  }, []);

  return (
    <Popover
      onOpenChange={(nextOpen) => {
        if (nextOpen) {
          openFind(view.id);
          return;
        }
        // Flush rather than cancel: the last keystrokes were only waiting out
        // the debounce, and the find they belong to survives this close.
        submit.flush();
        setColumnsShownFor(null);
        closeFind(view.id);
      }}
      open={open}
    >
      {/* One trigger element for both shapes. Swapping triggers while the
          popover is open leaves the positioner anchored to a node that is no
          longer in the document, and the panel lands in the top-left corner
          of the screen: the term is applied mid-typing, so the swap happens
          under an open bar every time. */}
      <div
        className={cn(
          "flex items-center",
          applied && "bg-muted/50 rounded-md border",
        )}
      >
        <PopoverTrigger
          // The chip names itself with the term it applied; only the bare icon
          // needs a label of its own.
          aria-label={applied ? undefined : t("workspaces.views.findInTable")}
          render={
            <Button
              className={cn(applied && "font-normal")}
              size={applied ? "xs" : "icon-xs"}
              variant="ghost"
            />
          }
          title={t("workspaces.views.findInTable")}
        >
          <SearchIcon className="size-3.5" />
          {applied && (
            <FindChipLabel
              columns={columns}
              selection={selection}
              term={applied.term}
            />
          )}
        </PopoverTrigger>
        {applied && (
          <Button
            aria-label={t("common.remove")}
            onClick={() => {
              clearFind(view.id);
            }}
            size="icon-xs"
            variant="ghost"
          >
            <XIcon className="size-3.5" />
          </Button>
        )}
      </div>
      {/* Escape closes the whole bar, column list and all: the popover owns
          that key, and racing it for a first level would be a shortcut whose
          effect depended on where focus happened to be. */}
      <PopoverPopup
        align="end"
        className="w-72 flex-col gap-2 p-2"
        ref={popupRef}
      >
        <div className="flex items-center gap-1">
          <Input
            aria-describedby={tooShort ? tooShortHintId : undefined}
            autoFocus
            className="flex-1"
            onChange={(event) => {
              setFindTyped(view.id, event.target.value);
              submit(view.id);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                // Enter means "search now", the way it does in the app's other
                // find bars: it submits what is typed ahead of the debounce,
                // and never submits a form or closes the bar.
                event.preventDefault();
                submit.flush();
              }
            }}
            placeholder={t("workspaces.views.findPlaceholder")}
            ref={bindInput}
            size="sm"
            type="search"
            value={find?.typed ?? ""}
          />
          <Button
            aria-expanded={columnsShown}
            aria-label={t("workspaces.views.findColumns")}
            onClick={() => {
              setColumnsShownFor(columnsShown ? null : view.id);
            }}
            size="icon-xs"
            title={t("workspaces.views.findColumns")}
            variant={columnsShown || narrowed ? "secondary" : "ghost"}
          >
            <Columns3Icon className="size-3.5" />
          </Button>
        </div>
        {tooShort && (
          <p className="text-muted-foreground px-1 text-xs" id={tooShortHintId}>
            {t("workspaces.views.findTermTooShort", {
              count: ENTITY_FIND_TERM_MIN_LENGTH,
            })}
          </p>
        )}
        {columnsShown && (
          <FindColumnList
            columns={pickerColumns}
            onChange={(next) => {
              setFindScope(view.id, next);
            }}
            searchable={searchable}
            selection={selection}
          />
        )}
      </PopoverPopup>
    </Popover>
  );
};

type FindChipLabelProps = {
  columns: TableFindColumn[];
  selection: TableFindSelection;
  term: string;
};

/**
 * The applied term, in the row where filters and sorts show theirs. A narrowed
 * selection rides along, since a term is read differently depending on where
 * it was looked for.
 */
const FindChipLabel = ({ columns, selection, term }: FindChipLabelProps) => {
  const t = useTranslations();
  const narrowedTo =
    selection.type === "columns" ? selection.propertyIds : null;
  const soleColumn =
    narrowedTo?.length === 1
      ? columns.find((column) => column.id === narrowedTo[0])
      : undefined;

  return (
    <>
      {/* User text, and a case name is long: it truncates rather than pushing
          the rest of the toolbar off screen. */}
      <span className="max-w-48 truncate">{term}</span>
      {narrowedTo !== null && (
        <span className="text-muted-foreground">
          {soleColumn?.label ??
            t("workspaces.views.findScopeColumns", {
              count: narrowedTo.length,
            })}
        </span>
      )}
    </>
  );
};

type FindColumnListProps = {
  columns: TableFindColumn[];
  onChange: (selection: TableFindSelection) => void;
  searchable: string[];
  selection: TableFindSelection;
};

/**
 * Which columns the find reaches. "All columns" is not the full list ticked: it
 * is the unrestricted state, which also matches the row's name and marks
 * matching headers, so under it the columns below show unticked and the first
 * click narrows to that one column. Columns whose type cannot be searched stay
 * listed, disabled and explained, so a missing column never reads as a bug.
 */
const FindColumnList = ({
  columns,
  onChange,
  searchable,
  selection,
}: FindColumnListProps) => {
  const t = useTranslations();
  const chosen = new Set(selection.type === "all" ? [] : selection.propertyIds);

  return (
    <div className="flex max-h-56 flex-col overflow-y-auto">
      <FindColumnRow
        checked={selection.type === "all"}
        label={t("workspaces.views.findAllColumns")}
        onClick={() => {
          onChange({ type: "all" });
        }}
      />
      {columns.map((column) => {
        if (column.kind === "metadata") {
          return (
            <FindColumnRow
              checked={false}
              disabled
              icon={<InfoIcon className="size-3.5 opacity-70" />}
              key={column.id}
              label={column.label}
              title={t("workspaces.views.findColumnMetadataNotSearchable")}
            />
          );
        }
        const excluded = column.support === "excluded";
        return (
          <FindColumnRow
            checked={!excluded && chosen.has(column.id)}
            disabled={excluded}
            icon={<PropertyIcon type={column.contentType} />}
            key={column.id}
            label={column.label}
            onClick={() => {
              onChange(
                toggleFindColumn({
                  columnId: column.id,
                  searchable,
                  selection,
                }),
              );
            }}
            title={
              excluded
                ? t("workspaces.views.findColumnNotSearchable")
                : undefined
            }
          />
        );
      })}
    </div>
  );
};

type FindColumnRowProps = {
  checked: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
  label: string;
  /** Absent on a row that is always disabled, which can never fire it. */
  onClick?: (() => void) | undefined;
  title?: string | undefined;
};

const FindColumnRow = ({
  checked,
  disabled = false,
  icon,
  label,
  onClick,
  title,
}: FindColumnRowProps) => (
  <button
    aria-pressed={checked}
    className={cn(
      "flex items-center gap-2 rounded px-2 py-1 text-start text-sm",
      disabled ? "opacity-56" : "hover:bg-accent cursor-pointer",
    )}
    disabled={disabled}
    onClick={onClick}
    title={title}
    type="button"
  >
    {icon}
    <span className="min-w-0 flex-1 truncate">{label}</span>
    {checked && <span className="text-primary">{"✓"}</span>}
  </button>
);

import { useRef, useState } from "react";

import { useHotkey } from "@tanstack/react-hotkeys";
import { Columns3Icon, SearchIcon } from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { cn } from "@stll/ui/utils";

import { PropertyIcon } from "@/components/workspaces/property-helpers";
import { useOwnsFind } from "@/lib/find-owner";
import type { WorkspaceProperty, WorkspaceView } from "@/lib/types";
import { useEffectiveHotkey } from "@/lib/use-effective-shortcuts";
import {
  searchableColumnIds,
  toggleFindColumn,
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
  properties: WorkspaceProperty[];
  view: WorkspaceView<"table">;
};

/**
 * Find-in-table: the toolbar half. It owns the term and the column scope; the
 * table layouts read both from the store and turn them into row queries.
 */
export const ViewToolbarSearch = ({
  properties,
  view,
}: ViewToolbarSearchProps) => {
  const t = useTranslations();
  const { columns } = useTableFind({ properties, view });
  const find = useTableStore((state) => state.find[view.id]);
  const openFind = useTableStore((state) => state.openFind);
  const closeFind = useTableStore((state) => state.closeFind);
  const setFindDraft = useTableStore((state) => state.setFindDraft);
  const commitFind = useTableStore((state) => state.commitFind);
  const setFindScope = useTableStore((state) => state.setFindScope);
  const inputRef = useRef<HTMLInputElement>(null);
  // The column picker lives inside this popover rather than in a menu of its
  // own: a nested popup counts as an outside press and closed the bar.
  const [columnsShown, setColumnsShown] = useState(false);

  const commit = useDebouncedCallback(() => {
    commitFind(view.id);
  }, FIND_DEBOUNCE_MS);

  const ownsFind = useOwnsFind("table", true);
  useHotkey(
    useEffectiveHotkey("findInTable"),
    () => {
      openFind(view.id);
      inputRef.current?.focus();
    },
    { enabled: ownsFind },
  );

  const searchable = searchableColumnIds(columns);
  const selection = find?.scope ?? { type: "all" };
  const narrowed = selection.type === "columns";

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) {
          openFind(view.id);
          return;
        }
        commit.cancel();
        setColumnsShown(false);
        closeFind(view.id);
      }}
      open={find !== undefined}
    >
      <PopoverTrigger
        aria-label={t("workspaces.views.findInTable")}
        render={<Button className="relative" size="icon-xs" variant="ghost" />}
        title={t("workspaces.views.findInTable")}
      >
        <SearchIcon className="size-3.5" />
        {narrowed && (
          <span className="bg-primary absolute end-0.5 top-0.5 size-1.5 rounded-full" />
        )}
      </PopoverTrigger>
      {/* Escape closes the whole bar, column list and all: the popover owns
          that key, and racing it for a first level would be a shortcut whose
          effect depended on where focus happened to be. */}
      <PopoverPopup align="end" className="w-72 flex-col gap-1 p-2">
        <div className="flex items-center gap-1">
          <Input
            autoFocus
            className="flex-1"
            onChange={(event) => {
              setFindDraft(view.id, event.target.value);
              commit();
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                // Enter means "search now", the way it does in the app's other
                // find bars; it never submits or closes.
                event.preventDefault();
                commit.flush();
              }
            }}
            placeholder={t("workspaces.views.findPlaceholder")}
            ref={inputRef}
            size="sm"
            type="search"
            value={find?.draft ?? ""}
          />
          <Button
            aria-expanded={columnsShown}
            aria-label={t("workspaces.views.findColumns")}
            onClick={() => {
              setColumnsShown((shown) => !shown);
            }}
            size="icon-xs"
            title={t("workspaces.views.findColumns")}
            variant={columnsShown || narrowed ? "secondary" : "ghost"}
          >
            <Columns3Icon className="size-3.5" />
          </Button>
        </div>
        {columnsShown && (
          <FindColumnList
            columns={columns}
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
  onClick: () => void;
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

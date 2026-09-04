import { useRef } from "react";

import { useHotkey } from "@tanstack/react-hotkeys";
import { Columns3Icon, SearchIcon } from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Input } from "@stll/ui/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@stll/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";

import { PropertyIcon } from "@/components/workspaces/property-helpers";
import { useOwnsFind } from "@/lib/find-owner";
import type { WorkspaceProperty, WorkspaceView } from "@/lib/types";
import { useEffectiveHotkey } from "@/lib/use-effective-shortcuts";
import { searchableColumnIds } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-find.logic";
import type { TableFindColumn } from "@/routes/_protected.workspaces/$workspaceId/-components/table/table-find.logic";
import { useTableStore } from "@/routes/_protected.workspaces/$workspaceId/-hooks/table-store";
import type { TableFindSelection } from "@/routes/_protected.workspaces/$workspaceId/-hooks/table-store";
import { useTableFind } from "@/routes/_protected.workspaces/$workspaceId/-hooks/use-table-find";

// The band every server-backed search in this app types at (the global search
// dialog and its facets); short enough to feel live, long enough that a typed
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

  const close = () => {
    commit.cancel();
    closeFind(view.id);
  };

  const searchable = searchableColumnIds(columns);
  const selection = find?.scope ?? { type: "all" };
  const narrowed =
    selection.type === "columns" &&
    selection.propertyIds.length < searchable.length;

  return (
    <Popover
      onOpenChange={(open) => {
        if (open) {
          openFind(view.id);
        } else {
          close();
        }
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
      <PopoverPopup align="start" className="w-72 flex-col gap-2 p-2">
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
                // Enter means "search now", the way it does in the two other
                // find bars; it never submits or closes.
                event.preventDefault();
                commit.flush();
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                close();
              }
            }}
            placeholder={t("workspaces.views.findPlaceholder")}
            ref={inputRef}
            size="sm"
            type="search"
            value={find?.draft ?? ""}
          />
          <FindColumnsMenu
            columns={columns}
            onChange={(next) => {
              setFindScope(view.id, next);
            }}
            searchable={searchable}
            selection={selection}
          />
        </div>
      </PopoverPopup>
    </Popover>
  );
};

type FindColumnsMenuProps = {
  columns: TableFindColumn[];
  onChange: (selection: TableFindSelection) => void;
  searchable: string[];
  selection: TableFindSelection;
};

/**
 * Which columns the find reaches. "All columns" is not the full list ticked: it
 * is the unrestricted state, which also matches the row's name and highlights
 * matching headers. Columns whose type cannot be searched stay listed, disabled
 * and explained, so a missing column never reads as a bug.
 */
const FindColumnsMenu = ({
  columns,
  onChange,
  searchable,
  selection,
}: FindColumnsMenuProps) => {
  const t = useTranslations();
  const chosen =
    selection.type === "all"
      ? new Set(searchable)
      : new Set(selection.propertyIds);

  const toggle = (columnId: string) => {
    const next = new Set(chosen);
    if (next.has(columnId)) {
      next.delete(columnId);
    } else {
      next.add(columnId);
    }
    // Deselecting the last column would ask for a search nothing can satisfy,
    // so it falls back to the unrestricted state instead.
    if (next.size === 0 || next.size === searchable.length) {
      onChange({ type: "all" });
      return;
    }
    onChange({
      propertyIds: searchable.filter((id) => next.has(id)),
      type: "columns",
    });
  };

  return (
    <Menu>
      <MenuTrigger
        aria-label={t("workspaces.views.findColumns")}
        render={<Button size="icon-xs" variant="ghost" />}
        title={t("workspaces.views.findColumns")}
      >
        <Columns3Icon className="size-3.5" />
      </MenuTrigger>
      <MenuPopup>
        <MenuItem
          closeOnClick={false}
          onClick={() => {
            onChange({ type: "all" });
          }}
        >
          <span className="flex-1">{t("workspaces.views.findAllColumns")}</span>
          {selection.type === "all" && (
            <span className="text-primary">{"✓"}</span>
          )}
        </MenuItem>
        {columns.length > 0 && (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>{t("common.columns")}</MenuGroupLabel>
              {columns.map((column) => {
                const excluded = column.support === "excluded";
                return (
                  <MenuItem
                    closeOnClick={false}
                    disabled={excluded}
                    key={column.id}
                    onClick={() => {
                      toggle(column.id);
                    }}
                    title={
                      excluded
                        ? t("workspaces.views.findColumnNotSearchable")
                        : undefined
                    }
                  >
                    <PropertyIcon type={column.contentType} />
                    <span className="flex-1">{column.label}</span>
                    {!excluded && chosen.has(column.id) && (
                      <span className="text-primary">{"✓"}</span>
                    )}
                  </MenuItem>
                );
              })}
            </MenuGroup>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
};

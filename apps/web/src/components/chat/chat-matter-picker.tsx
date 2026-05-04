import { useDeferredValue, useMemo, useRef, useState } from "react";

import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuTrigger,
} from "@stll/ui/components/menu";
import { useQuery } from "@tanstack/react-query";
import { ChevronDownIcon, LayersIcon, SearchIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { resolveMatterColor } from "@/lib/matter-colors";
import { workspacesNavigationOptions } from "@/routes/_protected.workspaces/-queries";

/**
 * Matter context picker rendered in the chat tab header.
 *
 * A chat can draw context from multiple matters at once — Phase D
 * will make this a real boundary on what the AI sees, today it's
 * captured as user intent so the wiring is in place.
 *
 * Built on stella's Menu primitive: scrolling, focus, keyboard nav
 * for free. Multi-select via `closeOnClick={false}` so the popup
 * stays open across toggles. Matters are grouped by client and
 * filterable via the search input at the top — same affordance as
 * the matter list in the app sidebar.
 */

type ChatMatterPickerProps = {
  /** Selected matter ids — full set the chat draws context from. */
  matterIds: string[];
  /** Replace the selected set. */
  onChange: (matterIds: string[]) => void;
};

const NO_CLIENT_KEY = "__no_client__";

type Matter = {
  id: string;
  name: string;
  color: string | null;
  clientKey: string;
  clientLabel: string;
};

type Group = {
  key: string;
  label: string;
  matters: Matter[];
};

export const ChatMatterPicker = ({
  matterIds,
  onChange,
}: ChatMatterPickerProps) => {
  const t = useTranslations();
  const [search, setSearch] = useState("");
  const deferredSearch = useDeferredValue(search);
  const searchRef = useRef<HTMLInputElement>(null);

  // Cache hit thanks to chat-mention-providers and the app sidebar
  // — the navigation list is already in flight on any workspace
  // page.
  const { data } = useQuery(workspacesNavigationOptions);
  const workspaces = data?.workspaces;

  const personalLabel = t("workspaces.parties.personalLabel");
  const matters = useMemo<Matter[]>(() => {
    if (!workspaces) {
      return [];
    }
    return workspaces.map((w) => ({
      id: w.id,
      name: w.name,
      color: w.color,
      clientKey: w.client?.id ?? NO_CLIENT_KEY,
      clientLabel: w.client?.displayName ?? personalLabel,
    }));
  }, [workspaces, personalLabel]);

  const matterById = useMemo(() => {
    const map = new Map<string, Matter>();
    for (const m of matters) {
      map.set(m.id, m);
    }
    return map;
  }, [matters]);

  // Resolve selected ids → records, dropping any the org no longer
  // recognises (matter deleted, permissions changed) so the trigger
  // never shows a phantom name.
  const selected = useMemo(
    () =>
      matterIds
        .map((id) => matterById.get(id))
        .filter((m): m is Matter => m !== undefined),
    [matterIds, matterById],
  );

  const filtered = useMemo(() => {
    const q = deferredSearch.trim().toLowerCase();
    if (q.length === 0) {
      return matters;
    }
    return matters.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.clientLabel.toLowerCase().includes(q),
    );
  }, [matters, deferredSearch]);

  const groups = useMemo<Group[]>(() => {
    const map = new Map<string, Group>();
    for (const m of filtered) {
      let group = map.get(m.clientKey);
      if (!group) {
        group = { key: m.clientKey, label: m.clientLabel, matters: [] };
        map.set(m.clientKey, group);
      }
      group.matters.push(m);
    }
    return [...map.values()].sort((a, b) => {
      // "Direct" sinks to the bottom; everything else alphabetical
      // by client name so the order is stable across renders.
      if (a.key === NO_CLIENT_KEY) {
        return 1;
      }
      if (b.key === NO_CLIENT_KEY) {
        return -1;
      }
      return a.label.localeCompare(b.label);
    });
  }, [filtered]);

  const allSelected = matters.length > 0 && selected.length === matters.length;
  const triggerLabel =
    selected.length === 0
      ? t("inspector.matterPicker.noMatter")
      : allSelected
        ? t("inspector.matterPicker.allMatters")
        : (selected[0]?.name ?? t("inspector.matterPicker.noMatter"));
  const extraCount =
    !allSelected && selected.length > 1 ? selected.length - 1 : 0;
  const triggerSwatch = selected[0]
    ? resolveMatterColor(selected[0].id, selected[0].color)
    : null;

  const toggle = (matterId: string) => {
    if (matterIds.includes(matterId)) {
      onChange(matterIds.filter((id) => id !== matterId));
    } else {
      onChange([...matterIds, matterId]);
    }
  };

  return (
    <Menu
      onOpenChange={(open) => {
        if (open) {
          // Defer focus past base-ui's own focus-trap logic so the
          // search input wins over auto-focusing the first item.
          setTimeout(() => searchRef.current?.focus(), 0);
        } else {
          setSearch("");
        }
      }}
    >
      <MenuTrigger
        className="text-muted-foreground hover:text-foreground hover:bg-accent inline-flex max-w-[220px] items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] transition-colors"
        title={
          selected.length > 1
            ? selected.map((m) => m.name).join(", ")
            : triggerLabel
        }
      >
        <LayersIcon
          aria-hidden="true"
          className="size-3 shrink-0"
          style={triggerSwatch ? { color: triggerSwatch } : undefined}
        />
        <span className="truncate">{triggerLabel}</span>
        {extraCount > 0 && (
          <span className="bg-muted text-foreground rounded-sm px-1 text-[10px] font-medium tabular-nums">
            +{extraCount}
          </span>
        )}
        <ChevronDownIcon
          aria-hidden="true"
          className="size-3 shrink-0 opacity-70"
        />
      </MenuTrigger>
      <MenuPopup align="start" className="w-72" sideOffset={6}>
        <div className="flex flex-col gap-1.5 border-b px-2 pt-1.5 pb-2">
          <p className="text-foreground text-xs font-medium">
            {t("inspector.matterPicker.title")}
          </p>
          <p className="text-muted-foreground text-[11px] leading-snug text-pretty">
            {t("inspector.matterPicker.description")}
          </p>
          <div className="border-input focus-within:border-ring focus-within:ring-ring/16 bg-background relative flex items-center gap-1.5 rounded-md border px-1.5 transition-shadow focus-within:ring-2">
            <SearchIcon
              aria-hidden="true"
              className="text-muted-foreground size-3.5 shrink-0"
            />
            <input
              className="placeholder:text-muted-foreground/80 h-7 w-full min-w-0 bg-transparent text-xs outline-none"
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => {
                // base-ui's Menu listens for keystrokes (typeahead
                // jumps to items, arrows move focus, etc.) which
                // hijacks the user's typing in this search input.
                // Stop every non-closing key so typed characters
                // actually land here, but keep Escape so the menu
                // can still be dismissed from inside the field.
                if (e.key !== "Escape") {
                  e.stopPropagation();
                }
              }}
              placeholder={t("inspector.matterPicker.searchPlaceholder")}
              ref={searchRef}
              type="text"
              value={search}
            />
          </div>
        </div>
        <div className="flex flex-col py-1">
          {/* "All matters" sits above the per-matter rows so users
              can scope the chat to the whole org in one click —
              and so chats opened outside any specific matter
              (e.g. /workspaces general view) have an obvious
              default to fall back to. Selecting it replaces the
              picked set with every matter currently visible to
              the user. Toggle off → empty selection. */}
          {workspaces !== undefined && matters.length > 0 && (
            <MenuCheckboxItem
              checked={allSelected}
              closeOnClick={false}
              onClick={() => {
                if (allSelected) {
                  onChange([]);
                } else {
                  onChange(matters.map((m) => m.id));
                }
              }}
            >
              <span className="flex min-w-0 items-center gap-2">
                <LayersIcon
                  aria-hidden="true"
                  className="text-muted-foreground size-3.5 shrink-0"
                />
                <span className="truncate text-xs font-medium">
                  {t("inspector.matterPicker.allMatters")}
                </span>
              </span>
            </MenuCheckboxItem>
          )}
          {workspaces === undefined ? (
            <div className="text-muted-foreground p-3 text-center text-xs">
              {t("common.loading")}
            </div>
          ) : groups.length === 0 ? (
            <div className="text-muted-foreground p-3 text-center text-xs">
              {search.length > 0
                ? t("inspector.matterPicker.noResults", { query: search })
                : t("inspector.matterPicker.empty")}
            </div>
          ) : (
            groups.map((group) => (
              <MenuGroup key={group.key}>
                <MenuGroupLabel>{group.label}</MenuGroupLabel>
                {group.matters.map((m) => {
                  const isOn = matterIds.includes(m.id);
                  const swatch = resolveMatterColor(m.id, m.color);
                  return (
                    <MenuCheckboxItem
                      checked={isOn}
                      closeOnClick={false}
                      key={m.id}
                      onClick={() => toggle(m.id)}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <LayersIcon
                          aria-hidden="true"
                          className="size-3.5 shrink-0"
                          style={{ color: swatch }}
                        />
                        <span className="truncate text-xs">{m.name}</span>
                      </span>
                    </MenuCheckboxItem>
                  );
                })}
              </MenuGroup>
            ))
          )}
        </div>
      </MenuPopup>
    </Menu>
  );
};

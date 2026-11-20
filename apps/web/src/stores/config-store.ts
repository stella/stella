import { create } from "zustand";
import { persist } from "zustand/middleware";

import { getStorageKey } from "@/consts";
import type {
  MattersColumnId,
  MattersFilters,
  MattersSortKey,
} from "@/lib/workspaces/types";
import { ALL_COLUMNS, MATTERS_SORT_KEYS } from "@/lib/workspaces/types";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

type ViewMode = "grid" | "table";
type MattersGroupBy = "none" | "client";

export type MattersConfig = {
  viewMode: ViewMode;
  sortKey: MattersSortKey;
  sortDesc: boolean;
  groupBy: MattersGroupBy;
  hiddenColumns: MattersColumnId[];
  clientFilter: string | null;
  collapsedGroups: string[];
  filters: MattersFilters;
};

const DEFAULT_MATTERS: MattersConfig = {
  viewMode: "grid",
  sortKey: "lastActivityAt",
  sortDesc: true,
  groupBy: "client",
  hiddenColumns: [],
  clientFilter: null,
  collapsedGroups: [],
  filters: {},
};

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/**
 * What the inbox's body was laid out from when this browser last drew it:
 * its view's layout, as far as the body's shape depends on it. A cold load,
 * which has no saved views to read yet, draws its loading body from this, so
 * the body it paints is the one the member left, never a guess.
 */
export type InboxLastLayout =
  | {
      type: "kanban";
      groupByPropertyId: string | null;
      subgroupByPropertyId: string | null;
    }
  | {
      type: "table";
      groupByPropertyId: string | null;
      hiddenProperties: string[];
      columnOrder: string[];
      columnPinning: string[];
    };

/** The inbox view this browser last drew, and whose it was. */
export type InboxLastView = {
  organizationId: string;
  viewId: string;
  layout: InboxLastLayout;
};

const optionalString = (value: unknown): string | null =>
  typeof value === "string" ? value : null;

const readInboxLastLayout = (value: unknown): InboxLastLayout | null => {
  if (!isRecord(value)) {
    return null;
  }
  if (value["type"] === "kanban") {
    return {
      type: "kanban",
      groupByPropertyId: optionalString(value["groupByPropertyId"]),
      subgroupByPropertyId: optionalString(value["subgroupByPropertyId"]),
    };
  }
  const { columnOrder, columnPinning, hiddenProperties } = value;
  if (
    value["type"] !== "table" ||
    !isStringArray(columnOrder) ||
    !isStringArray(columnPinning) ||
    !isStringArray(hiddenProperties)
  ) {
    return null;
  }
  return {
    type: "table",
    groupByPropertyId: optionalString(value["groupByPropertyId"]),
    hiddenProperties,
    columnOrder,
    columnPinning,
  };
};

const readInboxLastView = (persisted: unknown): InboxLastView | null => {
  if (!isRecord(persisted)) {
    return null;
  }
  const { organizationId, viewId } = persisted;
  const layout = readInboxLastLayout(persisted["layout"]);
  return typeof organizationId === "string" &&
    typeof viewId === "string" &&
    layout !== null
    ? { organizationId, viewId, layout }
    : null;
};

type ConfigState = {
  matters: MattersConfig;
  inbox: InboxLastView | null;
  /** Keeps the inbox view just drawn, for the next cold load's body. */
  rememberInboxView: (view: InboxLastView) => void;
  updateMatters: (patch: Partial<MattersConfig>) => void;
  setMattersFilter: <K extends keyof MattersFilters>(
    key: K,
    value: MattersFilters[K],
  ) => void;
  clearMattersFilter: (key: keyof MattersFilters) => void;
  clearAllMattersFilters: () => void;
  toggleMattersColumn: (id: MattersColumnId) => void;
  toggleGroupCollapsed: (groupId: string) => void;
};

export const CONFIG_STORE_VERSION = 2;

const isMattersColumnId = (value: unknown): value is MattersColumnId =>
  typeof value === "string" &&
  ALL_COLUMNS.some((columnId) => columnId === value);

const isMattersSortKey = (value: unknown): value is MattersSortKey =>
  typeof value === "string" &&
  MATTERS_SORT_KEYS.some((sortKey) => sortKey === value);

const readPersistedMatters = (persisted: unknown): MattersConfig => {
  if (!isRecord(persisted)) {
    return DEFAULT_MATTERS;
  }

  return {
    viewMode:
      persisted["viewMode"] === "grid" || persisted["viewMode"] === "table"
        ? persisted["viewMode"]
        : DEFAULT_MATTERS.viewMode,
    sortKey: isMattersSortKey(persisted["sortKey"])
      ? persisted["sortKey"]
      : DEFAULT_MATTERS.sortKey,
    sortDesc:
      typeof persisted["sortDesc"] === "boolean"
        ? persisted["sortDesc"]
        : DEFAULT_MATTERS.sortDesc,
    groupBy:
      persisted["groupBy"] === "none" || persisted["groupBy"] === "client"
        ? persisted["groupBy"]
        : DEFAULT_MATTERS.groupBy,
    hiddenColumns: Array.isArray(persisted["hiddenColumns"])
      ? persisted["hiddenColumns"].filter(isMattersColumnId)
      : DEFAULT_MATTERS.hiddenColumns,
    clientFilter: null,
    collapsedGroups: [],
    filters: {},
  };
};

export const toPersistedConfigState = (state: ConfigState) => ({
  matters: readPersistedMatters(state.matters),
  inbox: readInboxLastView(state.inbox),
});

export const migratePersistedConfigState = (persisted: unknown) => ({
  matters: readPersistedMatters(
    isRecord(persisted) ? persisted["matters"] : null,
  ),
  inbox: readInboxLastView(isRecord(persisted) ? persisted["inbox"] : null),
});

export const useConfigStore = create<ConfigState>()(
  persist(
    (set) => ({
      matters: DEFAULT_MATTERS,
      inbox: null,

      rememberInboxView: (view) => {
        set({ inbox: view });
      },

      updateMatters: (patch) => {
        set((s) => ({
          matters: { ...s.matters, ...patch },
        }));
      },

      setMattersFilter: (key, value) => {
        set((s) => ({
          matters: {
            ...s.matters,
            filters: { ...s.matters.filters, [key]: value },
          },
        }));
      },

      clearMattersFilter: (key) => {
        set((s) => {
          const { [key]: _omit, ...rest } = s.matters.filters;
          return { matters: { ...s.matters, filters: rest } };
        });
      },

      clearAllMattersFilters: () => {
        set((s) => ({
          matters: { ...s.matters, filters: {} },
        }));
      },

      toggleGroupCollapsed: (groupId) => {
        set((s) => {
          const current = s.matters.collapsedGroups;
          const next = current.includes(groupId)
            ? current.filter((id) => id !== groupId)
            : [...current, groupId];
          return { matters: { ...s.matters, collapsedGroups: next } };
        });
      },

      toggleMattersColumn: (id) => {
        set((s) => {
          const cur = s.matters.hiddenColumns;
          const isHidden = cur.includes(id);
          const next = isHidden ? cur.filter((c) => c !== id) : [...cur, id];
          const visibleCount = ALL_COLUMNS.length - next.length;
          if (visibleCount === 0) {
            return s;
          }
          return {
            matters: {
              ...s.matters,
              hiddenColumns: next,
            },
          };
        });
      },
    }),
    {
      name: getStorageKey("config"),
      version: CONFIG_STORE_VERSION,
      migrate: migratePersistedConfigState,
      partialize: toPersistedConfigState,
      merge: (persisted, current) => {
        const { inbox, matters } = migratePersistedConfigState(persisted);
        return {
          ...current,
          inbox,
          matters,
        };
      },
    },
  ),
);

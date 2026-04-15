import { create } from "zustand";
import { persist } from "zustand/middleware";

import { getStorageKey } from "@/consts";
import type {
  MattersColumnId,
  MattersSortKey,
} from "@/routes/_protected.workspaces/-types";
import { ALL_COLUMNS } from "@/routes/_protected.workspaces/-types";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null;

type ViewMode = "grid" | "table";
type MattersGroupBy = "none" | "client";

type MattersConfig = {
  viewMode: ViewMode;
  sortKey: MattersSortKey;
  sortDesc: boolean;
  groupBy: MattersGroupBy;
  hiddenColumns: MattersColumnId[];
  clientFilter: string | null;
  collapsedGroups: string[];
};

const DEFAULT_MATTERS: MattersConfig = {
  viewMode: "grid",
  sortKey: "lastActivityAt",
  sortDesc: true,
  groupBy: "client",
  hiddenColumns: [],
  clientFilter: null,
  collapsedGroups: [],
};

type ConfigState = {
  matters: MattersConfig;
  updateMatters: (patch: Partial<MattersConfig>) => void;
  toggleMattersColumn: (id: MattersColumnId) => void;
  toggleGroupCollapsed: (groupId: string) => void;
};

export const useConfigStore = create<ConfigState>()(
  persist(
    (set) => ({
      matters: DEFAULT_MATTERS,

      updateMatters: (patch) =>
        set((s) => ({
          matters: { ...s.matters, ...patch },
        })),

      toggleGroupCollapsed: (groupId) =>
        set((s) => {
          const current = s.matters.collapsedGroups ?? [];
          const next = current.includes(groupId)
            ? current.filter((id) => id !== groupId)
            : [...current, groupId];
          return { matters: { ...s.matters, collapsedGroups: next } };
        }),

      toggleMattersColumn: (id) =>
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
        }),
    }),
    {
      name: getStorageKey("config"),
      version: 1,
      migrate: () => null,
      merge: (persisted, current) => {
        if (!isRecord(persisted)) {
          return current;
        }
        const prev = isRecord(persisted.matters) ? persisted.matters : {};
        return {
          ...current,
          matters: { ...DEFAULT_MATTERS, ...prev },
        };
      },
    },
  ),
);

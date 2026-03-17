import { create } from "zustand";
import { persist } from "zustand/middleware";

import { getStorageKey } from "@/consts";
import type {
  MattersColumnId,
  MattersSortKey,
} from "@/routes/_protected.workspaces/-types";
import { ALL_COLUMNS } from "@/routes/_protected.workspaces/-types";

type ViewMode = "grid" | "table";
type MattersGroupBy = "none" | "client";

type MattersConfig = {
  viewMode: ViewMode;
  sortKey: MattersSortKey;
  sortDesc: boolean;
  groupBy: MattersGroupBy;
  hiddenColumns: MattersColumnId[];
  clientFilter: string | null;
};

const DEFAULT_MATTERS: MattersConfig = {
  viewMode: "grid",
  sortKey: "lastActivityAt",
  sortDesc: true,
  groupBy: "none",
  hiddenColumns: [],
  clientFilter: null,
};

type ConfigState = {
  matters: MattersConfig;
  updateMatters: (patch: Partial<MattersConfig>) => void;
  toggleMattersColumn: (id: MattersColumnId) => void;
};

export const useConfigStore = create<ConfigState>()(
  persist(
    (set) => ({
      matters: DEFAULT_MATTERS,

      updateMatters: (patch) =>
        set((s) => ({
          matters: { ...s.matters, ...patch },
        })),

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
    },
  ),
);

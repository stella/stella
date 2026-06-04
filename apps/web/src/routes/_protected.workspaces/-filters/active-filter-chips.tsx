import { useMemo } from "react";

import { XIcon } from "lucide-react";
import { useTranslations } from "use-intl";
import { useShallow } from "zustand/shallow";

import { cn } from "@stll/ui/lib/utils";

import { useI18nStore } from "@/i18n/i18n-store";
import { parseLocalISODateMs } from "@/routes/_protected.workspaces/-filters/filter-pipeline";
import type { Workspace } from "@/routes/_protected.workspaces/-types";
import { useConfigStore } from "@/stores/config-store";

type ActiveFilterChipsProps = {
  workspaces: readonly Workspace[];
};

export const ActiveFilterChips = ({ workspaces }: ActiveFilterChipsProps) => {
  const t = useTranslations();
  const lang = useI18nStore((s) => s.lang);
  const { filters, clearFilter, clearAll } = useConfigStore(
    useShallow((s) => ({
      filters: s.matters.filters,
      clearFilter: s.clearMattersFilter,
      clearAll: s.clearAllMattersFilters,
    })),
  );

  const memberNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const w of workspaces) {
      for (const m of w.members) {
        map.set(m.userId, m.userName);
      }
    }
    return map;
  }, [workspaces]);

  const chips: { key: string; label: string; clear: () => void }[] = [];

  const formatDateChip = (filter: {
    preset: string;
    from?: string;
    to?: string;
  }): string => {
    if (filter.preset === "today") {
      return t("common.today");
    }
    if (filter.preset === "thisWeek") {
      return t("workspaces.filters.date.thisWeek");
    }
    if (filter.preset === "last7d") {
      return t("workspaces.filters.date.last7d");
    }
    if (filter.preset === "last30d") {
      return t("workspaces.filters.date.last30d");
    }
    if (filter.preset === "thisMonth") {
      return t("workspaces.filters.date.thisMonth");
    }
    const fromLabel = filter.from
      ? new Date(parseLocalISODateMs(filter.from)).toLocaleDateString(lang)
      : null;
    const toLabel = filter.to
      ? new Date(parseLocalISODateMs(filter.to)).toLocaleDateString(lang)
      : null;
    if (fromLabel && toLabel) {
      return t("workspaces.filters.date.customRange", {
        from: fromLabel,
        to: toLabel,
      });
    }
    if (fromLabel) {
      return t("workspaces.filters.date.from", { date: fromLabel });
    }
    if (toLabel) {
      return t("workspaces.filters.date.to", { date: toLabel });
    }
    return t("workspaces.filters.date.custom");
  };

  if (filters.lastActivityAt) {
    chips.push({
      key: "lastActivityAt",
      label: t("workspaces.filters.chips.lastActivityAt", {
        label: formatDateChip(filters.lastActivityAt),
      }),
      clear: () => clearFilter("lastActivityAt"),
    });
  }

  if (filters.createdAt) {
    chips.push({
      key: "createdAt",
      label: t("workspaces.filters.chips.createdAt", {
        label: formatDateChip(filters.createdAt),
      }),
      clear: () => clearFilter("createdAt"),
    });
  }

  if (filters.client && filters.client.length > 0) {
    chips.push({
      key: "client",
      label: t("workspaces.filters.chips.client", {
        count: filters.client.length,
      }),
      clear: () => clearFilter("client"),
    });
  }

  if (filters.team && filters.team.length > 0) {
    chips.push({
      key: "team",
      label: t("workspaces.filters.chips.team", {
        count: filters.team.length,
      }),
      clear: () => clearFilter("team"),
    });
  }

  if (filters.lead) {
    const lead = filters.lead;
    let inner: string;
    if (lead.type === "any") {
      inner = t("workspaces.filters.chips.leadAny");
    } else if (lead.type === "none") {
      inner = t("workspaces.filters.chips.leadNone");
    } else {
      inner = memberNames.get(lead.userId) ?? lead.userId;
    }
    chips.push({
      key: "lead",
      label: t("workspaces.filters.chips.lead", { label: inner }),
      clear: () => clearFilter("lead"),
    });
  }

  if (filters.entityCount) {
    const f = filters.entityCount;
    let inner: string;
    if (f.gte !== undefined && f.lte !== undefined) {
      inner = t("workspaces.filters.items.between", {
        from: String(f.gte),
        to: String(f.lte),
      });
    } else if (f.gte !== undefined) {
      inner = t("workspaces.filters.items.min", { value: String(f.gte) });
    } else if (f.lte !== undefined) {
      inner = t("workspaces.filters.items.max", { value: String(f.lte) });
    } else {
      inner = "";
    }
    chips.push({
      key: "entityCount",
      label: t("workspaces.filters.chips.items", { label: inner }),
      clear: () => clearFilter("entityCount"),
    });
  }

  if (chips.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1.5 border-b px-3 py-1.5 text-xs",
      )}
    >
      {chips.map((chip) => (
        <button
          className={cn(
            "bg-muted/72 hover:bg-muted text-muted-foreground hover:text-foreground",
            "inline-flex items-center gap-1 rounded-full px-2 py-0.5 transition-colors",
          )}
          key={chip.key}
          onClick={chip.clear}
          type="button"
        >
          <span>{chip.label}</span>
          <XIcon className="size-3" />
        </button>
      ))}
      <button
        className="text-muted-foreground hover:text-foreground ms-1 underline-offset-2 hover:underline"
        onClick={clearAll}
        type="button"
      >
        {t("workspaces.filters.clearAll")}
      </button>
    </div>
  );
};

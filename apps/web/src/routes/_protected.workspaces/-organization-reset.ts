import type { MattersFilters } from "@/lib/workspaces/types";

type MatterOrganizationResetPatch = {
  collapsedGroups: string[];
  filters: MattersFilters;
};

export const getMatterOrganizationResetPatch =
  (): MatterOrganizationResetPatch => ({
    collapsedGroups: [],
    filters: {},
  });

import type { MattersFilters } from "@/routes/_protected.workspaces/-types";

type MatterOrganizationResetPatch = {
  collapsedGroups: string[];
  filters: MattersFilters;
};

export const getMatterOrganizationResetPatch =
  (): MatterOrganizationResetPatch => ({
    collapsedGroups: [],
    filters: {},
  });

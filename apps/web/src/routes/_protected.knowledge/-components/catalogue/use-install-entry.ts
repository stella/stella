import { useMutation, useQueryClient } from "@tanstack/react-query";

import { installCatalogueEntry } from "@/lib/catalogue-install";
import { catalogueKeys } from "@/routes/_protected.knowledge/-queries/catalogue";

import type { CatalogueEntry } from "./catalogue-types";

/**
 * Installs a catalogue entry by routing to the right backend mutation
 * per kind (see `installCatalogueEntry`), then invalidates the affected
 * caches so the catalogue, MCP, and skills views refresh.
 */
export const useInstallEntry = (organizationId: string) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (entry: CatalogueEntry) => installCatalogueEntry(entry),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: catalogueKeys.list(organizationId),
      });
      void queryClient.invalidateQueries({ queryKey: ["mcp"] });
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });
};

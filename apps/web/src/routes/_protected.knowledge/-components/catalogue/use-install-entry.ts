import { useMutation, useQueryClient } from "@tanstack/react-query";

import { catalogueKeys } from "@/components/catalogue/catalogue-queries";
import { installCatalogueEntry } from "@/lib/catalogue-install";

import type { CatalogueEntry } from "./catalogue-types";

/**
 * Installs a catalogue entry by routing to the right backend mutation
 * per kind (see `installCatalogueEntry`), then invalidates the affected
 * caches so the catalogue, MCP, and skills views refresh.
 */
export const useInstallEntry = (organizationId: string) => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (entry: CatalogueEntry) =>
      await installCatalogueEntry(entry),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: catalogueKeys.list(organizationId),
      });
      void queryClient.invalidateQueries({ queryKey: ["mcp"] });
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
    },
  });
};

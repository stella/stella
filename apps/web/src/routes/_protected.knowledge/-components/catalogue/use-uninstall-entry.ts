import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/components/toast";

import { api } from "@/lib/api";
import { toAPIError } from "@/lib/errors";
import { toSafeId } from "@/lib/safe-id";
import { knowledgeKeys } from "@/routes/_protected.knowledge/-queries";
import { catalogueKeys } from "@/routes/_protected.knowledge/-queries/catalogue";

import type { CatalogueEntry } from "./catalogue-types";

/**
 * Uninstalls a catalogue entry by routing to the right backend
 * mutation per kind. Mirrors `useInstallEntry` so detail surfaces
 * (settings list + inspector view) can share the same hook.
 */
export const useUninstallEntry = (
  entry: CatalogueEntry,
  organizationId: string,
) => {
  const t = useTranslations();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      if (entry.kind === "native-tool") {
        const response = await api.mcp["native-tools"]({
          slug: entry.backendSlug,
        }).patch({ enabled: false, queryKey: ["mcp"] });
        if (response.error) {
          throw toAPIError(response.error);
        }
        return;
      }
      if (entry.kind === "mcp") {
        if (!entry.installedConnectorSlug) {
          return;
        }
        const response = await api.mcp
          .connectors({ slug: entry.installedConnectorSlug })
          .delete({ queryKey: ["mcp"] });
        if (response.error) {
          throw toAPIError(response.error);
        }
        return;
      }
      if (!entry.installedSkillId) {
        return;
      }
      const response = await api
        .skills({ skillId: toSafeId<"agentSkill">(entry.installedSkillId) })
        .delete({ queryKey: ["skills"] });
      if (response.error) {
        throw toAPIError(response.error);
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: catalogueKeys.list(organizationId),
      });
      void queryClient.invalidateQueries({ queryKey: ["mcp"] });
      void queryClient.invalidateQueries({ queryKey: ["skills"] });
      void queryClient.invalidateQueries({
        queryKey: knowledgeKeys.mcp.all(organizationId),
      });
      stellaToast.add({
        title: t("common.remove"),
        type: "success",
      });
    },
    onError: (error) => {
      stellaToast.add({
        title:
          error instanceof Error ? error.message : t("errors.actionFailed"),
        type: "error",
      });
    },
  });
};

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/components/toast";

import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import { userErrorFromThrown } from "@/lib/errors/user-safe";
import { knowledgeKeys } from "@/lib/knowledge/queries";
import { catalogueKeys } from "@/lib/knowledge/queries/catalogue";
import { toSafeId } from "@/lib/safe-id";

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
        }).patch({ enabled: false });
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
          .delete({});
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
        .delete({});
      if (response.error) {
        throw toAPIError(response.error);
      }
    },
    onSuccess: () => {
      detached(
        queryClient.invalidateQueries({
          queryKey: catalogueKeys.list(organizationId),
        }),
        "onSuccess",
      );
      detached(
        queryClient.invalidateQueries({ queryKey: ["mcp"] }),
        "onSuccess",
      );
      detached(
        queryClient.invalidateQueries({ queryKey: ["skills"] }),
        "onSuccess",
      );
      detached(
        queryClient.invalidateQueries({
          queryKey: knowledgeKeys.mcp.all(organizationId),
        }),
        "onSuccess",
      );
      stellaToast.add({
        title: t("common.remove"),
        type: "success",
      });
    },
    onError: (error) => {
      stellaToast.add({
        title: userErrorFromThrown(error, t("errors.actionFailed")),
        type: "error",
      });
    },
  });
};

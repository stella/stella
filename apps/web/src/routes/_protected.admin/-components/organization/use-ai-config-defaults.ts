import { useQuery } from "@tanstack/react-query";

import {
  projectDefaultRoleModels,
  projectProviderDefaultRoleModels,
} from "@/components/ai-config-role-models.logic";
import type { ProviderValue } from "@/components/ai-config-role-models.logic";
import { aiDefaultsPreviewOptions } from "@/lib/organization/ai-config-queries";
import type { OrganizationAIConfig } from "@/lib/organization/ai-config-queries";
import { useQueryView, useQueryViewError } from "@/lib/use-query-view";

type UseAIConfigDefaultsOptions = {
  config: OrganizationAIConfig | null;
  organizationId: string;
  providers: readonly ProviderValue[];
};

export const useAIConfigDefaults = ({
  config,
  organizationId,
  providers,
}: UseAIConfigDefaultsOptions) => {
  const storedProviders = config?.configured
    ? config.providers.map(({ provider }) => provider)
    : [];
  const defaultsQuery = useQuery({
    ...aiDefaultsPreviewOptions({ organizationId, providers }),
    enabled: config !== null,
    ...(config !== null &&
    JSON.stringify(providers) === JSON.stringify(storedProviders)
      ? {
          initialData: {
            defaultModels: projectDefaultRoleModels(config.defaultModels),
            providerDefaultModels: projectProviderDefaultRoleModels(
              config.providerDefaultModels,
            ),
          },
        }
      : {}),
  });
  const defaultsView = useQueryView(defaultsQuery);
  useQueryViewError(defaultsView, "useAIConfigDefaults:query");
  return {
    defaultModels:
      defaultsView.type === "items" ? defaultsView.items.defaultModels : null,
    providerDefaultModels:
      defaultsView.type === "items"
        ? defaultsView.items.providerDefaultModels
        : [],
    defaultsView,
  };
};

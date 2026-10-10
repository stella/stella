import type { QueryClient } from "@tanstack/react-query";

import { chatKeys } from "@/features/chat/chat-query-contract";
import { aiConfigKeys } from "@/lib/organization/ai-config-queries";

/**
 * Every organization-scoped view derived from the AI provider configuration.
 * Saving or deleting providers changes which chat models are selectable, so
 * the chat model options refetch alongside the configuration itself.
 */
export const invalidateAIConfigurationCaches = async (
  queryClient: QueryClient,
  organizationId: string,
): Promise<void> => {
  await Promise.all([
    queryClient.invalidateQueries({
      queryKey: aiConfigKeys.byOrganization({ organizationId }),
    }),
    queryClient.invalidateQueries({
      queryKey: aiConfigKeys.availability({ organizationId }),
    }),
    queryClient.invalidateQueries({
      queryKey: chatKeys.modelOptions(organizationId),
    }),
  ]);
};

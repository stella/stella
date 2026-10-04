import { QueryClient } from "@tanstack/react-query";
import { describe, expect, test } from "bun:test";

import { chatKeys } from "@/features/chat/chat-query-contract";
import { invalidateAIConfigurationCaches } from "@/lib/organization/ai-config-cache";
import { aiConfigKeys } from "@/lib/organization/ai-config-queries";

describe("AI configuration cache invalidation", () => {
  test("invalidates every view of one organization's provider configuration", async () => {
    const organizationId = "organization-1";
    const otherOrganizationId = "organization-2";
    const queryClient = new QueryClient();
    const affectedKeys = [
      aiConfigKeys.byOrganization({ organizationId }),
      aiConfigKeys.availability({ organizationId }),
      chatKeys.modelOptions(organizationId),
    ];
    const unaffectedKey = chatKeys.modelOptions(otherOrganizationId);
    for (const queryKey of [...affectedKeys, unaffectedKey]) {
      queryClient.setQueryData(queryKey, { cached: true });
    }

    await invalidateAIConfigurationCaches(queryClient, organizationId);

    for (const queryKey of affectedKeys) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    }
    expect(queryClient.getQueryState(unaffectedKey)?.isInvalidated).toBe(false);
  });
});

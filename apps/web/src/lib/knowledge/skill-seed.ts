import { queryOptions } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";

import { detached } from "@/lib/detached";
import { knowledgeKeys } from "@/lib/knowledge/queries";
import { catalogueKeys } from "@/lib/knowledge/queries/catalogue";

type SeedSkills = () => Promise<{ seeded: boolean }>;

// Outside the skills and catalogue roots on purpose: those are invalidated
// after every skill change, and an invalidated seed would run again.
const skillSeedKey = (organizationId: string) =>
  ["agent-skill-seed", organizationId] as const;

// One successful seed per organization per session: the result never goes
// stale and is never collected, while a failure leaves no data behind, so the
// next Tools visit tries again.
const skillSeedOptions = (organizationId: string, seedSkills: SeedSkills) =>
  queryOptions({
    queryKey: skillSeedKey(organizationId),
    queryFn: async ({ client }) => {
      const result = await seedSkills();
      // New default skills must reach the slash menu and an open catalogue
      // now rather than when their cached lists go stale.
      if (result.seeded) {
        await Promise.all([
          client.invalidateQueries({
            queryKey: knowledgeKeys.skills.all(organizationId),
          }),
          client.invalidateQueries({
            queryKey: catalogueKeys.all(organizationId),
          }),
        ]);
      }
      return result;
    },
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
    retry: false,
  });

type StartSkillSeedOptions = {
  queryClient: QueryClient;
  organizationId: string;
  seedSkills: SeedSkills;
};

/**
 * Seed the default slash-command skills without holding up the Tools page:
 * the request runs detached and refreshes the affected lists when it lands.
 */
export const startSkillSeed = ({
  queryClient,
  organizationId,
  seedSkills,
}: StartSkillSeedOptions): void => {
  detached(
    queryClient.fetchQuery(skillSeedOptions(organizationId, seedSkills)),
    "skill-seed.fetch",
  );
};

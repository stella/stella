import { WORKSPACE_ACCESS_MODE } from "@/api/db/rls";
import type { WorkspaceScope } from "@/api/db/scoped";
import { resolveScopedFeatureIds } from "@/api/db/scoped-feature-access";
import { LIMITS } from "@/api/lib/limits";
import type { SearchQuery } from "@/api/lib/search/types";
import type { GatedTestDb } from "@/api/tests/gated-test-database";

import type { QueryPerfProfileId } from "./profiles";
import { loadSyntheticProfile } from "./synthetic/load-profile";
import { readSeededProfile, seedProdShaped } from "./synthetic/seed";

export const QUERY_PERF_SEED_ID = "document-search-synthetic-v1";

type SeedQueryPerfOptions = {
  database: GatedTestDb;
  profileId: QueryPerfProfileId;
  source: "fresh" | "snapshot";
};

export const seedQueryPerf = async ({
  database,
  profileId,
  source,
}: SeedQueryPerfOptions) => {
  const profile = loadSyntheticProfile(profileId);
  const { organizationId, userId, bigWorkspaceId, query, searchMatchCount } =
    source === "fresh"
      ? await seedProdShaped(database, profile)
      : await readSeededProfile(database, profile);
  return {
    searchMatchCount,
    context: {
      organizationId,
      userId,
      workspaceScope: {
        type: WORKSPACE_ACCESS_MODE.membership,
        serverValidatedWorkspaceIds: [],
      } as const satisfies WorkspaceScope,
      featureIds: await database.transaction(
        async (tx) =>
          await resolveScopedFeatureIds({ tx, organizationId, userId }),
      ),
    },
    searchInput: {
      query,
      organizationId,
      workspaceIds: [bigWorkspaceId],
      limit: LIMITS.mcpSearchPageSizeDefault,
    } satisfies SearchQuery,
  };
};

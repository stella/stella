import type { env } from "@/api/env";
import { FEATURE_REGISTRY } from "@/api/lib/feature-access/registry";

import { DEFAULT_ORG_ID } from "../seed-utils";

/**
 * The configured grants plus an organization grant to the seeded organization
 * for every invitation feature in the registry, so a newly registered feature
 * reaches the seeded stack without a hand-kept list.
 */
export const withSeededOrganizationGrants = (
  grants: typeof env.API_FEATURE_ACCESS_GRANTS,
): typeof env.API_FEATURE_ACCESS_GRANTS => ({
  ...grants,
  ...Object.fromEntries(
    Object.entries(FEATURE_REGISTRY)
      .filter(([, { enrolment }]) => enrolment === "invitation")
      .map(([featureId]) => [
        featureId,
        [
          ...(grants[featureId] ?? []),
          { type: "organization", organizationId: DEFAULT_ORG_ID },
        ],
      ]),
  ),
});

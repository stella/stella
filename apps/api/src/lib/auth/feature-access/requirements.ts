import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import type { FeatureId } from "@/api/lib/feature-access/registry";
import type { AdvertisedSchemas } from "@/api/mcp/advertised-schema";

type FeatureResourceContext = {
  body: unknown;
  params: unknown;
  query: unknown;
  workspaceId?: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  safeDb: SafeDb;
  scopedDb: ScopedDb;
};

export type FeatureAccessRequirement =
  | { featureId: FeatureId; type: "required" }
  | {
      featureId: FeatureId;
      type: "conditional";
      usesFeature: (context: FeatureResourceContext) => Promise<boolean>;
      projectInputSchema: (schemas: AdvertisedSchemas) => AdvertisedSchemas;
    };

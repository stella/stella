import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import type { SafeId } from "@/api/lib/branded-types";
import type { FeatureId } from "@/api/lib/feature-access/registry";
import type { AdvertisedSchemas } from "@/api/mcp/advertised-schema";

export type FeatureResourceContext = {
  body: unknown;
  params: unknown;
  query: unknown;
  workspaceId?: SafeId<"workspace">;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user"> | null;
  safeDb: SafeDb;
  scopedDb: ScopedDb;
};

export type FeatureAccessRequirement =
  | { featureId: FeatureId; type: "required" }
  | {
      featureId: FeatureId;
      type: "conditional";
      decision: "always" | "when-used";
      usesFeature: (
        context: FeatureResourceContext,
      ) => boolean | Promise<boolean>;
      projectInputSchema: (schemas: AdvertisedSchemas) => AdvertisedSchemas;
    };

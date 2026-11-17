import type { FeatureAccessRequirement } from "@/api/lib/auth/feature-access/requirements";
import { TABLE_ANALYSIS_FEATURE_ID } from "@/api/lib/feature-access/registry";
import { isRecord } from "@/api/lib/type-guards";
import type { AdvertisedSchemas } from "@/api/mcp/advertised-schema";

/**
 * Admission for the table-analysis column capabilities on the property write
 * bodies. Only a body that configures one (today: an AI column returning
 * money) needs the feature; every other column is created as before.
 */

const createBodyUsesTableAnalysis = (body: unknown): boolean =>
  isRecord(body) &&
  body["contentType"] === "money" &&
  body["toolType"] === "ai-model";

const updateBodyUsesTableAnalysis = (body: unknown): boolean =>
  isRecord(body) &&
  isRecord(body["content"]) &&
  body["content"]["type"] === "money" &&
  isRecord(body["tool"]) &&
  body["tool"]["type"] === "ai-model";

// The body schemas carry no field that only this feature uses (a money column
// and an AI tool are each valid alone), so there is nothing to hide from an
// agent without it; the combination is refused at admission instead.
const unchangedInputSchemas = (schemas: AdvertisedSchemas) => schemas;

export const CREATE_PROPERTIES_BATCH_TABLE_ANALYSIS_ACCESS = {
  featureId: TABLE_ANALYSIS_FEATURE_ID,
  type: "conditional",
  decision: "when-used",
  usesFeature: ({ body }) =>
    isRecord(body) &&
    Array.isArray(body["items"]) &&
    body["items"].some(createBodyUsesTableAnalysis),
  projectInputSchema: unchangedInputSchemas,
} as const satisfies FeatureAccessRequirement;

export const CREATE_PROPERTY_TABLE_ANALYSIS_ACCESS = {
  featureId: TABLE_ANALYSIS_FEATURE_ID,
  type: "conditional",
  decision: "when-used",
  usesFeature: ({ body }) => createBodyUsesTableAnalysis(body),
  projectInputSchema: unchangedInputSchemas,
} as const satisfies FeatureAccessRequirement;

export const UPDATE_PROPERTY_TABLE_ANALYSIS_ACCESS = {
  featureId: TABLE_ANALYSIS_FEATURE_ID,
  type: "conditional",
  decision: "when-used",
  usesFeature: ({ body }) => updateBodyUsesTableAnalysis(body),
  projectInputSchema: unchangedInputSchemas,
} as const satisfies FeatureAccessRequirement;

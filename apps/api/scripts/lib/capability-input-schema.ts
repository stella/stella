import { KindGuard } from "@sinclair/typebox";
import { panic } from "better-result";

import { isRecord } from "../../src/lib/type-guards";
import { advertisedSchema } from "../../src/mcp/advertised-schema";
import type { AdvertisedSchemas } from "../../src/mcp/advertised-schema";
import { withPublicFieldNames } from "../../src/mcp/public-field-names";
import type { CapabilityInputSchema } from "./capability-catalog";

export const parseFeatureRequirement = (value: unknown) => {
  if (!isRecord(value) || typeof value["featureId"] !== "string") {
    return undefined;
  }
  const type = value["type"];
  if (type !== "required" && type !== "conditional") {
    return undefined;
  }
  return { featureId: value["featureId"], type } as const;
};

type ConditionalSchemaRequirement = {
  projectInputSchema: (schemas: AdvertisedSchemas) => AdvertisedSchemas;
};

const hasSchemaProjection = (
  value: unknown,
): value is ConditionalSchemaRequirement =>
  isRecord(value) && typeof value["projectInputSchema"] === "function";

const canonicalSchemaPart = (value: unknown) => {
  if (value === undefined) {
    return undefined;
  }
  if (!KindGuard.IsSchema(value)) {
    return panic("Conditional feature access requires TypeBox input schemas");
  }
  return value;
};

const staticInputSchemas = (config: Record<string, unknown>) => {
  const requirement = config["featureAccess"];
  if (parseFeatureRequirement(requirement)?.type !== "conditional") {
    return {
      body: config["body"],
      params: config["params"],
      query: config["query"],
    };
  }
  if (!hasSchemaProjection(requirement)) {
    return panic(
      "Conditional feature access requires an input schema projection",
    );
  }
  return requirement.projectInputSchema({
    body: canonicalSchemaPart(config["body"]),
    params: canonicalSchemaPart(config["params"]),
    query: canonicalSchemaPart(config["query"]),
  });
};

/**
 * The catalog carries the same projection `describe_capability` advertises
 * (coercion unions flattened to their scalar), so the CLI's generated flags
 * and the MCP surface enforce one contract. A part that is not a TypeBox
 * schema is left as the handler declared it.
 */
const advertisedPart = (part: unknown): unknown =>
  KindGuard.IsSchema(part) ? advertisedSchema(part) : part;

// The config's `body`/`params`/`query` are TypeBox schemas: plain JSON Schema
// objects at runtime plus non-enumerable symbol metadata. The final
// `JSON.stringify` of the whole catalog drops those symbols, leaving clean JSON
// Schema on disk, so the raw schema value can go straight into the entry.
export const buildInputSchema = (
  config: Record<string, unknown>,
): CapabilityInputSchema => {
  const schemas = staticInputSchemas(config);
  const inputSchema: CapabilityInputSchema = {};
  if (schemas.body !== undefined) {
    inputSchema.body = withPublicFieldNames(advertisedPart(schemas.body));
  }
  if (schemas.params !== undefined) {
    inputSchema.params = withPublicFieldNames(advertisedPart(schemas.params));
  }
  if (schemas.query !== undefined) {
    inputSchema.query = withPublicFieldNames(advertisedPart(schemas.query));
  }
  return inputSchema;
};

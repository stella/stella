import { panic } from "better-result";
import type { GenericSchema } from "valibot";

import { isValibotSchema } from "../../src/lib/json-schema/valibot-to-json-schema";
import { isRecord } from "../../src/lib/type-guards";
import { advertisedSchemas } from "../../src/mcp/advertised-schema";
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

/** A route input slot: a valibot schema, or absent. */
const inputPart = (value: unknown): GenericSchema | undefined => {
  if (value === undefined) {
    return undefined;
  }
  return isValibotSchema(value)
    ? value
    : panic("Capability input schemas must be valibot schemas");
};

/**
 * The catalog carries the same rendering `describe_capability` advertises
 * (wire strings shown as the values they carry), projected for a conditional
 * feature the way an agent without it sees the capability, so the CLI's
 * generated flags and the MCP surface read one contract.
 */
const staticInputSchemas = (
  config: Record<string, unknown>,
): AdvertisedSchemas => {
  const schemas = advertisedSchemas({
    body: inputPart(config["body"]),
    params: inputPart(config["params"]),
    query: inputPart(config["query"]),
  });
  const requirement = config["featureAccess"];
  if (parseFeatureRequirement(requirement)?.type !== "conditional") {
    return schemas;
  }
  if (!hasSchemaProjection(requirement)) {
    return panic(
      "Conditional feature access requires an input schema projection",
    );
  }
  return requirement.projectInputSchema(schemas);
};

/** A capability's input parts as the catalog stores them: rendered, with public field names. */
export const buildInputSchema = (
  config: Record<string, unknown>,
): CapabilityInputSchema => {
  const schemas = staticInputSchemas(config);
  const inputSchema: CapabilityInputSchema = {};
  if (schemas.body !== undefined) {
    inputSchema.body = withPublicFieldNames(schemas.body);
  }
  if (schemas.params !== undefined) {
    inputSchema.params = withPublicFieldNames(schemas.params);
  }
  if (schemas.query !== undefined) {
    inputSchema.query = withPublicFieldNames(schemas.query);
  }
  return inputSchema;
};

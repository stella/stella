import { KindGuard } from "@sinclair/typebox";
import { panic } from "better-result";

import { isRecord } from "../../src/lib/type-guards";
import { advertisedSchema } from "../../src/mcp/advertised-schema";
import type { AdvertisedSchemas } from "../../src/mcp/advertised-schema";
import { PUBLIC_FIELD_NAME } from "../../src/mcp/public-field-names";
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

/** Schema keywords whose value is itself a schema node. */
const SCHEMA_NODE_KEYWORDS = ["items", "additionalProperties", "not"] as const;
/** Schema keywords whose value is a list of schema nodes. */
const SCHEMA_NODE_LIST_KEYWORDS = ["anyOf", "oneOf", "allOf"] as const;
/** Schema keywords whose value maps names to schema nodes. */
const SCHEMA_NODE_MAP_KEYWORDS = [
  "properties",
  "$defs",
  "definitions",
] as const;

/**
 * Rename internal input fields to their public spelling on the way out, at
 * every depth.
 *
 * The container is a `workspaceId` in the DB, the handler config and the REST
 * route; it is a `matterId` to every agent. This is the outbound half of that
 * split: `describe_capability` and the CLI's generated `--matter-id` flag both
 * read this schema. The inbound half is `withInternalFieldNames`
 * (apps/api/src/mcp/capability-tools.ts), which renames the field back before
 * the handler's own schema validates it, so the two names never both reach a
 * handler. Both halves derive from `PUBLIC_FIELD_NAME`'s one table.
 *
 * The walk covers every place a schema node can hide (`properties`, `items`,
 * `additionalProperties`, `anyOf`/`oneOf`/`allOf`, `$defs`), because the
 * container is not always top level: `flows.create` carries it inside a union
 * branch of `body.trigger`, `playbooks.create` inside an array of passages,
 * `signals.acceptances.create` inside `body.result`. Renaming only the top
 * level would advertise `--matter-id` on one capability and
 * `--body-trigger-workspace-id` on the next.
 *
 * The exemption is evaluated per NODE, not per part: a node that already owns
 * the public name (`expenses.create` body declares its own `matterId`) has no
 * internal name to rename, so the two cannot meet.
 */
const withPublicFieldNames = (node: unknown): unknown => {
  if (Array.isArray(node)) {
    return node.map((entry) => withPublicFieldNames(entry));
  }
  if (!isRecord(node)) {
    return node;
  }
  const rename = (name: string): string => PUBLIC_FIELD_NAME[name] ?? name;
  const projected = new Map(Object.entries(node));

  for (const keyword of SCHEMA_NODE_KEYWORDS) {
    if (keyword in node) {
      projected.set(keyword, withPublicFieldNames(node[keyword]));
    }
  }
  for (const keyword of SCHEMA_NODE_LIST_KEYWORDS) {
    const branches = node[keyword];
    if (Array.isArray(branches)) {
      projected.set(
        keyword,
        branches.map((branch) => withPublicFieldNames(branch)),
      );
    }
  }
  for (const keyword of SCHEMA_NODE_MAP_KEYWORDS) {
    const members = node[keyword];
    if (!isRecord(members)) {
      continue;
    }
    // `$defs`/`definitions` name reusable schemas, not input fields, so only
    // `properties` keys are renamed; every value is still descended into.
    const renameKeys = keyword === "properties";
    if (renameKeys) {
      for (const [internal, publicName] of Object.entries(PUBLIC_FIELD_NAME)) {
        if (internal in members && publicName in members) {
          panic(
            `capability input declares both ${internal} and ${publicName}; the public rename would drop one`,
          );
        }
      }
    }
    projected.set(
      keyword,
      Object.fromEntries(
        Object.entries(members).map(([name, member]) => [
          renameKeys ? rename(name) : name,
          withPublicFieldNames(member),
        ]),
      ),
    );
  }

  const required = node["required"];
  if (Array.isArray(required)) {
    projected.set(
      "required",
      required.map((name) => (typeof name === "string" ? rename(name) : name)),
    );
  }
  return Object.fromEntries(projected);
};

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

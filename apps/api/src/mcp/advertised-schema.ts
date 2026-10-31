import type * as v from "valibot";

import {
  type JsonSchema,
  toRouteJsonSchema,
} from "@/api/lib/json-schema/valibot-to-json-schema";

type EndpointInputParts = {
  readonly body?: v.GenericSchema | undefined;
  readonly params?: v.GenericSchema | undefined;
  readonly query?: v.GenericSchema | undefined;
};

/**
 * One capability's input parts as every agent-facing surface shows them:
 * `describe_capability` renders them, the capability executors repair agent
 * input against them, and the committed capability catalog (hence the CLI's
 * generated commands) embeds them. The route's own schemas still decide what
 * a call may carry; this is their rendering.
 */
export type AdvertisedSchemas = {
  readonly body: JsonSchema | undefined;
  readonly params: JsonSchema | undefined;
  readonly query: JsonSchema | undefined;
};

/**
 * A part is a node inside the capability's description, not a document of its
 * own, so it carries no `$schema` dialect.
 */
const advertisedPart = (
  schema: v.GenericSchema | undefined,
): JsonSchema | undefined => {
  if (schema === undefined) {
    return undefined;
  }
  const { $schema: _dialect, ...part } = toRouteJsonSchema(schema);
  return part;
};

/** The three advertised part schemas of one capability's live endpoint config. */
export const advertisedSchemas = (
  config: EndpointInputParts,
): AdvertisedSchemas => ({
  body: advertisedPart(config.body),
  params: advertisedPart(config.params),
  query: advertisedPart(config.query),
});

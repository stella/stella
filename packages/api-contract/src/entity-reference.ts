import * as v from "valibot";

import { safeIdSchema } from "./safe-id";

/** A contextual resource may be unavailable while its owning record remains usable. */
export const ENTITY_CONTEXT_REFERENCE_SCHEMA = v.nullable(
  v.variant("type", [
    v.strictObject({ type: v.literal("available"), id: safeIdSchema }),
    v.strictObject({ type: v.literal("unavailable") }),
  ]),
);

export type EntityContextReference = v.InferOutput<
  typeof ENTITY_CONTEXT_REFERENCE_SCHEMA
>;

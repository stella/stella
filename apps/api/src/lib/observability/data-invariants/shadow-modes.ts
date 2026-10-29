import type * as v from "valibot";

import type { envBaseServerSchema } from "@/api/env-base-schema";
import type { envApiServerSchema } from "@/api/env-schema";
import {
  DATA_INVARIANT_ID,
  type DataInvariantId,
} from "@/api/lib/observability/data-invariants/invariant";

/** The mode value that runs a feature beside the live path without serving it. */
export const SHADOW_MODE = "shadow";

/**
 * The keys of an environment schema whose parsed value can be `shadow`. A
 * free-form string is excluded: it could hold anything, and is not a mode.
 */
type ShadowModeKeys<Schemas> = {
  [Key in keyof Schemas]: Schemas[Key] extends v.GenericSchema
    ? string extends v.InferOutput<Schemas[Key]>
      ? never
      : typeof SHADOW_MODE extends v.InferOutput<Schemas[Key]>
        ? Key
        : never
    : never;
}[keyof Schemas];

type ShadowModeEnvKey = ShadowModeKeys<
  typeof envBaseServerSchema & typeof envApiServerSchema
>;

/**
 * The invariants that judge each shadow-mode feature's output. A shadow mode
 * returns normally whatever it computes, so nothing else would notice it
 * comparing against nothing.
 *
 * Total over the API's shadow-mode settings: a new `shadow` value in either
 * server schema fails to compile until it names an invariant here, and the
 * census test walks every environment schema at runtime for the ones the type
 * cannot see.
 */
export const SHADOW_MODE_INVARIANTS = {
  QUERY_EXPANSION_MODE: [DATA_INVARIANT_ID.queryExpansionDictionaries],
} as const satisfies Record<
  ShadowModeEnvKey,
  readonly [DataInvariantId, ...DataInvariantId[]]
>;

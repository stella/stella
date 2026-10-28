import * as v from "valibot";

import { envBaseServerSchema } from "@/api/env-base-schema";

const ingestionEnvironmentSchema = v.object({
  INGESTION_USER_AGENT: envBaseServerSchema.INGESTION_USER_AGENT,
});

/**
 * Reads the ingestion user-agent override without validating the whole API
 * environment: offline tools import ingestion adapters only to map and hash
 * records. An empty value counts as unset, as it does in `envBase`.
 */
export const readIngestionUserAgentOverride = () =>
  v.parse(ingestionEnvironmentSchema, {
    INGESTION_USER_AGENT: process.env["INGESTION_USER_AGENT"] || undefined,
  }).INGESTION_USER_AGENT;

import { envBase } from "@/api/env-base";
import { APP_VERSION } from "@/api/lib/version";

/** Identifies ingestion requests; forks can override it in their environment. */
export const INGESTION_USER_AGENT =
  envBase.INGESTION_USER_AGENT ??
  `stella-ingestion/${APP_VERSION} (+https://github.com/stella/stella)`;

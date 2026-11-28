// parser-output-unchanged: extracted pure adapter runtime, PL, and AT-RIS modules into @stll/case-law-adapters; parsed output is unchanged.
// parser-output-unchanged: the user agent is read without the API environment; the value and parsed records are unchanged.
import { registerIngestionUserAgent } from "@stll/case-law-ingestion-core/ingestion-user-agent-hook";

import { readIngestionUserAgentOverride } from "@/api/env-ingestion";
import { APP_VERSION } from "@/api/lib/version";

/**
 * Identifies ingestion requests; forks can override it in their environment.
 *
 * Not read through `envBase`: every ingestion adapter imports this through the
 * shared adapter utilities, and `envBase` validates the whole API environment
 * at module load.
 */
export const INGESTION_USER_AGENT =
  readIngestionUserAgentOverride() ??
  `stella-ingestion/${APP_VERSION} (+https://github.com/stella/stella)`;

registerIngestionUserAgent(INGESTION_USER_AGENT);

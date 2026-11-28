// parser-output-unchanged: [at-verg] extracted pure adapter runtime, PL, and AT-RIS modules into @stll/case-law-adapters; parsed output is unchanged.
// parser-output-unchanged: extracted pure adapter runtime, PL, and AT-RIS modules into @stll/case-law-adapters; parsed output is unchanged.
// parser-output-unchanged: imports moved to @stll/case-law-ingestion-core; runtime behavior unchanged.
import { ADAPTER_KEYS } from "@stll/case-law-ingestion-core/case-law-consts";

import { createAtRisSourceAdapter, defineAtRisSource } from "./at-courts";

export const AT_VERG_SOURCE = defineAtRisSource({
  application: "Verg",
  excludeForeignCourts: false,
  key: ADAPTER_KEYS.AT_VERG,
});

export const atVergAdapter = createAtRisSourceAdapter(AT_VERG_SOURCE);

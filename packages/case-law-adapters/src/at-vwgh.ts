// parser-output-unchanged: [at-vwgh] extracted pure adapter runtime, PL, and AT-RIS modules into @stll/case-law-adapters; parsed output is unchanged.
// parser-output-unchanged: extracted pure adapter runtime, PL, and AT-RIS modules into @stll/case-law-adapters; parsed output is unchanged.
// parser-output-unchanged: imports moved to @stll/case-law-ingestion-core; runtime behavior unchanged.
import { ADAPTER_KEYS } from "@stll/case-law-ingestion-core/case-law-consts";

import { createAtRisSourceAdapter, defineAtRisSource } from "./at-courts";

export const AT_VWGH_SOURCE = defineAtRisSource({
  application: "Vwgh",
  excludeForeignCourts: false,
  key: ADAPTER_KEYS.AT_VWGH,
});

export const atVwghAdapter = createAtRisSourceAdapter(AT_VWGH_SOURCE);

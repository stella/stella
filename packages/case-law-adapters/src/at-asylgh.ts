// parser-output-unchanged: [at-asylgh] extracted pure adapter runtime, PL, and AT-RIS modules into @stll/case-law-adapters; parsed output is unchanged.
// parser-output-unchanged: extracted pure adapter runtime, PL, and AT-RIS modules into @stll/case-law-adapters; parsed output is unchanged.
// parser-output-unchanged: imports moved to @stll/case-law-ingestion-core; runtime behavior unchanged.
import { ADAPTER_KEYS } from "@stll/case-law-ingestion-core/case-law-consts";

import { createAtRisSourceAdapter, defineAtRisSource } from "./at-courts";

export const AT_ASYLGH_SOURCE = defineAtRisSource({
  application: "AsylGH",
  excludeForeignCourts: false,
  key: ADAPTER_KEYS.AT_ASYLGH,
});

export const atAsylghAdapter = createAtRisSourceAdapter(AT_ASYLGH_SOURCE);

// parser-output-unchanged: [at-vfgh] extracted pure adapter runtime, PL, and AT-RIS modules into @stll/case-law-adapters; parsed output is unchanged.
// parser-output-unchanged: extracted pure adapter runtime, PL, and AT-RIS modules into @stll/case-law-adapters; parsed output is unchanged.
// parser-output-unchanged: imports moved to @stll/case-law-ingestion-core; runtime behavior unchanged.
import { ADAPTER_KEYS } from "@stll/case-law-ingestion-core/case-law-consts";

import { createAtRisSourceAdapter, defineAtRisSource } from "./at-courts";

export const AT_VFGH_SOURCE = defineAtRisSource({
  application: "Vfgh",
  excludeForeignCourts: false,
  key: ADAPTER_KEYS.AT_VFGH,
});

export const atVfghAdapter = createAtRisSourceAdapter(AT_VFGH_SOURCE);

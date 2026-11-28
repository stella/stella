// parser-output-unchanged: imports moved to @stll/case-law-ingestion-core; runtime behavior unchanged.
import { ADAPTER_KEYS } from "@stll/case-law-ingestion-core/case-law-consts";

import {
  createAtRisSourceAdapter,
  defineAtRisSource,
} from "@/api/handlers/case-law/ingestion/adapters/at-courts";

export const AT_BVWG_SOURCE = defineAtRisSource({
  application: "Bvwg",
  excludeForeignCourts: false,
  key: ADAPTER_KEYS.AT_BVWG,
});

export const atBvwgAdapter = createAtRisSourceAdapter(AT_BVWG_SOURCE);

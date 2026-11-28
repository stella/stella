// parser-output-unchanged: imports moved to @stll/case-law-ingestion-core; runtime behavior unchanged.
import { ADAPTER_KEYS } from "@stll/case-law-ingestion-core/case-law-consts";

import {
  createAtRisSourceAdapter,
  defineAtRisSource,
} from "@/api/handlers/case-law/ingestion/adapters/at-courts";

export const AT_BKS_SOURCE = defineAtRisSource({
  application: "Bks",
  excludeForeignCourts: false,
  key: ADAPTER_KEYS.AT_BKS,
});

export const atBksAdapter = createAtRisSourceAdapter(AT_BKS_SOURCE);

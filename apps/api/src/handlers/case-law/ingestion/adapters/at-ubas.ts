// parser-output-unchanged: imports moved to @stll/case-law-ingestion-core; runtime behavior unchanged.
import { ADAPTER_KEYS } from "@stll/case-law-ingestion-core/case-law-consts";

import {
  createAtRisSourceAdapter,
  defineAtRisSource,
} from "@/api/handlers/case-law/ingestion/adapters/at-courts";

export const AT_UBAS_SOURCE = defineAtRisSource({
  application: "Ubas",
  excludeForeignCourts: false,
  key: ADAPTER_KEYS.AT_UBAS,
});

export const atUbasAdapter = createAtRisSourceAdapter(AT_UBAS_SOURCE);

import { ADAPTER_KEYS } from "@stll/case-law-ingestion-core/case-law-consts";

import {
  createAtRisSourceAdapter,
  defineAtRisSource,
} from "@/api/handlers/case-law/ingestion/adapters/at-courts";

export const AT_LVWG_SOURCE = defineAtRisSource({
  application: "Lvwg",
  excludeForeignCourts: false,
  key: ADAPTER_KEYS.AT_LVWG,
});

export const atLvwgAdapter = createAtRisSourceAdapter(AT_LVWG_SOURCE);

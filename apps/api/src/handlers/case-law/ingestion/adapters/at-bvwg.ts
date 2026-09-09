import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
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

import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  createAtRisSourceAdapter,
  defineAtRisSource,
} from "@/api/handlers/case-law/ingestion/adapters/at-courts";

export const AT_VWGH_SOURCE = defineAtRisSource({
  application: "Vwgh",
  excludeForeignCourts: false,
  key: ADAPTER_KEYS.AT_VWGH,
});

export const atVwghAdapter = createAtRisSourceAdapter(AT_VWGH_SOURCE);

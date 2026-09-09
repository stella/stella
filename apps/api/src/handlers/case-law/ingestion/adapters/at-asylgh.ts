import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  createAtRisSourceAdapter,
  defineAtRisSource,
} from "@/api/handlers/case-law/ingestion/adapters/at-courts";

export const AT_ASYLGH_SOURCE = defineAtRisSource({
  application: "AsylGH",
  excludeForeignCourts: false,
  key: ADAPTER_KEYS.AT_ASYLGH,
});

export const atAsylghAdapter = createAtRisSourceAdapter(AT_ASYLGH_SOURCE);

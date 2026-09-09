import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
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

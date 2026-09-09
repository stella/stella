import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  createAtRisSourceAdapter,
  defineAtRisSource,
} from "@/api/handlers/case-law/ingestion/adapters/at-courts";

export const AT_VFGH_SOURCE = defineAtRisSource({
  application: "Vfgh",
  excludeForeignCourts: false,
  key: ADAPTER_KEYS.AT_VFGH,
});

export const atVfghAdapter = createAtRisSourceAdapter(AT_VFGH_SOURCE);

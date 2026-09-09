import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  createAtRisSourceAdapter,
  defineAtRisSource,
} from "@/api/handlers/case-law/ingestion/adapters/at-courts";

export const AT_UMSE_SOURCE = defineAtRisSource({
  application: "Umse",
  excludeForeignCourts: false,
  key: ADAPTER_KEYS.AT_UMSE,
});

export const atUmseAdapter = createAtRisSourceAdapter(AT_UMSE_SOURCE);

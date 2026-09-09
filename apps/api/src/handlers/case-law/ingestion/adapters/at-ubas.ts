import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
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

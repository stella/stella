import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  createAtRisSourceAdapter,
  defineAtRisSource,
} from "@/api/handlers/case-law/ingestion/adapters/at-courts";

export const AT_VERG_SOURCE = defineAtRisSource({
  application: "Verg",
  excludeForeignCourts: false,
  key: ADAPTER_KEYS.AT_VERG,
});

export const atVergAdapter = createAtRisSourceAdapter(AT_VERG_SOURCE);

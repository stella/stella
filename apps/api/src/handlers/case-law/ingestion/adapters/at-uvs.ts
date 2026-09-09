import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  createAtRisSourceAdapter,
  defineAtRisSource,
} from "@/api/handlers/case-law/ingestion/adapters/at-courts";

export const AT_UVS_SOURCE = defineAtRisSource({
  application: "Uvs",
  excludeForeignCourts: false,
  key: ADAPTER_KEYS.AT_UVS,
});

export const atUvsAdapter = createAtRisSourceAdapter(AT_UVS_SOURCE);

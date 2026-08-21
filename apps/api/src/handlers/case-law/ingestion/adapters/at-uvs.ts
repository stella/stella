import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  createAtRisSourceAdapter,
  type AtRisSourceDefinition,
} from "@/api/handlers/case-law/ingestion/adapters/at-courts";

export const AT_UVS_SOURCE = {
  application: "Uvs",
  excludeForeignCourts: false,
  firstSlice: "1991-02",
  key: ADAPTER_KEYS.AT_UVS,
  lastSlice: "2013-12",
  name: "Austrian Independent Administrative Senates (RIS UVS)",
} as const satisfies AtRisSourceDefinition;

export const atUvsAdapter = createAtRisSourceAdapter(AT_UVS_SOURCE);

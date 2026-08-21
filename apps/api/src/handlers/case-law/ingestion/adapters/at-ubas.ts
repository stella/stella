import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  createAtRisSourceAdapter,
  type AtRisSourceDefinition,
} from "@/api/handlers/case-law/ingestion/adapters/at-courts";

export const AT_UBAS_SOURCE = {
  application: "Ubas",
  excludeForeignCourts: false,
  firstSlice: "1998-01",
  key: ADAPTER_KEYS.AT_UBAS,
  lastSlice: "2008-06",
  name: "Austrian Federal Asylum Senate (RIS UBAS)",
} as const satisfies AtRisSourceDefinition;

export const atUbasAdapter = createAtRisSourceAdapter(AT_UBAS_SOURCE);

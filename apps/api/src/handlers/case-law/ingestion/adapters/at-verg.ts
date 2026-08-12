import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  createAtRisSourceAdapter,
  type AtRisSourceDefinition,
} from "@/api/handlers/case-law/ingestion/adapters/at-courts";

export const AT_VERG_SOURCE = {
  application: "Verg",
  excludeForeignCourts: false,
  firstSlice: "1994-04",
  key: ADAPTER_KEYS.AT_VERG,
  lastSlice: "2013-12",
  name: "Austrian Procurement Review Bodies (RIS Verg)",
} as const satisfies AtRisSourceDefinition;

export const atVergAdapter = createAtRisSourceAdapter(AT_VERG_SOURCE);

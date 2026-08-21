import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  createAtRisSourceAdapter,
  type AtRisSourceDefinition,
} from "@/api/handlers/case-law/ingestion/adapters/at-courts";

export const AT_VWGH_SOURCE = {
  application: "Vwgh",
  excludeForeignCourts: false,
  firstSlice: "1876-10",
  key: ADAPTER_KEYS.AT_VWGH,
  name: "Austrian Administrative Court (RIS VwGH)",
} as const satisfies AtRisSourceDefinition;

export const atVwghAdapter = createAtRisSourceAdapter(AT_VWGH_SOURCE);

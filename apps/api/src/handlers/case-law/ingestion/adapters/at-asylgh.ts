import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  createAtRisSourceAdapter,
  type AtRisSourceDefinition,
} from "@/api/handlers/case-law/ingestion/adapters/at-courts";

export const AT_ASYLGH_SOURCE = {
  application: "AsylGH",
  excludeForeignCourts: false,
  firstSlice: "2008-07",
  key: ADAPTER_KEYS.AT_ASYLGH,
  lastSlice: "2013-12",
  name: "Austrian Asylum Court (RIS AsylGH)",
} as const satisfies AtRisSourceDefinition;

export const atAsylghAdapter = createAtRisSourceAdapter(AT_ASYLGH_SOURCE);

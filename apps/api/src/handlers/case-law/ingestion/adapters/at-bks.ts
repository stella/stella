import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  createAtRisSourceAdapter,
  type AtRisSourceDefinition,
} from "@/api/handlers/case-law/ingestion/adapters/at-courts";

export const AT_BKS_SOURCE = {
  application: "Bks",
  excludeForeignCourts: false,
  firstSlice: "2001-10",
  key: ADAPTER_KEYS.AT_BKS,
  lastSlice: "2013-12",
  name: "Austrian Federal Communications Senate (RIS BKS)",
} as const satisfies AtRisSourceDefinition;

export const atBksAdapter = createAtRisSourceAdapter(AT_BKS_SOURCE);

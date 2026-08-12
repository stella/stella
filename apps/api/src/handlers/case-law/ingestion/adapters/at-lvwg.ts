import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  createAtRisSourceAdapter,
  type AtRisSourceDefinition,
} from "@/api/handlers/case-law/ingestion/adapters/at-courts";

export const AT_LVWG_SOURCE = {
  application: "Lvwg",
  excludeForeignCourts: false,
  firstSlice: "2002-03",
  key: ADAPTER_KEYS.AT_LVWG,
  name: "Austrian State Administrative Courts (RIS LVwG)",
} as const satisfies AtRisSourceDefinition;

export const atLvwgAdapter = createAtRisSourceAdapter(AT_LVWG_SOURCE);

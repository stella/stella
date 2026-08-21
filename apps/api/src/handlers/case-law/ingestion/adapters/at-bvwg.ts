import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  createAtRisSourceAdapter,
  type AtRisSourceDefinition,
} from "@/api/handlers/case-law/ingestion/adapters/at-courts";

export const AT_BVWG_SOURCE = {
  application: "Bvwg",
  excludeForeignCourts: false,
  firstSlice: "2014-01",
  key: ADAPTER_KEYS.AT_BVWG,
  name: "Austrian Federal Administrative Court (RIS BVwG)",
} as const satisfies AtRisSourceDefinition;

export const atBvwgAdapter = createAtRisSourceAdapter(AT_BVWG_SOURCE);

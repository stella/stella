import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  createAtRisSourceAdapter,
  type AtRisSourceDefinition,
} from "@/api/handlers/case-law/ingestion/adapters/at-courts";

export const AT_UMSE_SOURCE = {
  application: "Umse",
  excludeForeignCourts: false,
  firstSlice: "1995-10",
  key: ADAPTER_KEYS.AT_UMSE,
  lastSlice: "2013-12",
  name: "Austrian Environmental Senate (RIS Umweltsenat)",
} as const satisfies AtRisSourceDefinition;

export const atUmseAdapter = createAtRisSourceAdapter(AT_UMSE_SOURCE);

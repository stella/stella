import { ADAPTER_KEYS } from "@/api/handlers/case-law/consts";
import {
  createAtRisSourceAdapter,
  type AtRisSourceDefinition,
} from "@/api/handlers/case-law/ingestion/adapters/at-courts";

export const AT_VFGH_SOURCE = {
  application: "Vfgh",
  excludeForeignCourts: false,
  firstSlice: "1919-03",
  key: ADAPTER_KEYS.AT_VFGH,
  name: "Austrian Constitutional Court (RIS VfGH)",
} as const satisfies AtRisSourceDefinition;

export const atVfghAdapter = createAtRisSourceAdapter(AT_VFGH_SOURCE);

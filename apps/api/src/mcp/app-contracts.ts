import type * as v from "valibot";

import {
  LOOKUP_CASE_LAW_PROJECTION,
  SEARCH_CASE_LAW_PROJECTION,
} from "../lib/chat/case-law-result-projections";
import type { PresentationApp } from "./apps/manifest";

export const MCP_APP_OUTPUT_SCHEMAS = {
  search_case_law: SEARCH_CASE_LAW_PROJECTION,
  lookup_case_law: LOOKUP_CASE_LAW_PROJECTION,
} as const satisfies Record<
  PresentationApp["linkedTools"][number],
  v.GenericSchema
>;

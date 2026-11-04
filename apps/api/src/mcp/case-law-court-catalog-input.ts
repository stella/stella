import * as v from "valibot";

import type { AgentInputNormalizationAnnotation } from "@stll/agent-input";
import { PUBLIC_CASE_LAW_COUNTRIES } from "@stll/api-contract/case-law-launch-readiness";

import {
  countryInputSchema,
  countryNormalization,
  nullAsAbsent,
} from "@/api/mcp/input-schemas";

export const READ_CASE_LAW_COURTS_TOOL = "read_case_law_courts";

export const readCaseLawCourtsArgsSchema = nullAsAbsent(
  v.strictObject({
    country: countryInputSchema("Corpus country whose courts to list."),
  }),
);

export const READ_CASE_LAW_COURTS_INPUT_NORMALIZATION = {
  country: countryNormalization({
    spelling: "alpha-3",
    admitted: PUBLIC_CASE_LAW_COUNTRIES,
    tool: READ_CASE_LAW_COURTS_TOOL,
  }),
} as const satisfies Readonly<
  Record<string, AgentInputNormalizationAnnotation>
>;

import * as v from "valibot";

import {
  COURT_TIER_LABELS,
  type CourtTierLabel,
} from "@stll/api-contract/case-law-court-tiers";
import { compareCodeUnit } from "@stll/collation";

import { courtTierLabelFromMap } from "@/api/lib/case-law/court-weights";
import { loadPublicCourtWeights } from "@/api/lib/case-law/public-case-law-config";
import { CASE_LAW_COURT_CATALOG_PROJECTION } from "@/api/lib/chat/case-law-court-catalog-projection";
import {
  READ_CASE_LAW_COURTS_INPUT_NORMALIZATION,
  READ_CASE_LAW_COURTS_TOOL,
  readCaseLawCourtsArgsSchema,
} from "@/api/mcp/case-law-court-catalog-input";
import {
  loadCaseLawCourtNames,
  storedCourtIdentities,
} from "@/api/mcp/case-law-court-filter";
import { defineMcpToolSet } from "@/api/mcp/tool-types";
import type {
  McpToolDefinition,
  TypedMcpToolHandler,
} from "@/api/mcp/tool-types";
import {
  structuredErrorResult,
  toolDataResult,
  validationErrorResult,
} from "@/api/mcp/tool-utils";
import {
  defineMcpToolOutput,
  defineValibotMcpTool,
} from "@/api/mcp/valibot-tool-definition";
import { openMcpRead } from "@/api/mcp/write-tool-authority";

const READ_CASE_LAW_COURTS_TOOL_DEFINITION = defineValibotMcpTool({
  consumesServices: false,
  access: "read",
  permissions: openMcpRead("public case-law corpus"),
  readClass: "public",
  anonymized: { exposure: "passthrough" },
  feature: "FEATURE_PUBLIC_LAW",
  scope: "stella:read",
  name: READ_CASE_LAW_COURTS_TOOL,
  annotations: {
    title: "List case-law courts",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  description:
    "Widget-only list of every court the corpus holds for a country, grouped by tier, for the search court filter.",
  inputSchema: readCaseLawCourtsArgsSchema,
  inputNormalization: READ_CASE_LAW_COURTS_INPUT_NORMALIZATION,
  _meta: { ui: { visibility: ["app"] } },
});

type CourtCatalog = v.InferInput<typeof CASE_LAW_COURT_CATALOG_PROJECTION>;

/**
 * One entry per court, as the search's court filter reads it: a court the
 * corpus spells several ways is listed once, under the spelling the filter
 * maps every other spelling onto. Tiers apex first; courts by name within a
 * tier, so the list does not reorder between calls. Counts are left to the
 * caller, which has them for the result set it is narrowing.
 */
export const courtCatalog = ({
  country,
  courts,
  tierOf,
}: {
  country: string;
  courts: readonly string[];
  tierOf: (court: string) => CourtTierLabel;
}): CourtCatalog => {
  const entries = storedCourtIdentities(country, courts).map(
    ({ spellings: [value, ...aliases] }) => ({
      value,
      aliases: aliases.toSorted(compareCodeUnit),
      tier: tierOf(value),
    }),
  );
  return {
    country,
    courts: COURT_TIER_LABELS.flatMap((tierLabel) => {
      const tierCourts = entries
        .filter(({ tier }) => tier === tierLabel)
        .toSorted((left, right) => compareCodeUnit(left.value, right.value))
        .map(({ value, aliases }) => ({ value, aliases }));
      return tierCourts.length === 0 ? [] : [{ tierLabel, courts: tierCourts }];
    }),
  };
};

const listCourtsTool: TypedMcpToolHandler<CourtCatalog> = async ({
  args,
  context,
}) => {
  const parsed = v.safeParse(readCaseLawCourtsArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const { country } = parsed.output;
  const courts = await loadCaseLawCourtNames(context, country);
  if (courts === null) {
    return structuredErrorResult({
      code: "public_read_timeout",
      message: "The court list could not be read in time.",
      hint: "Retry the call.",
      retryable: true,
    });
  }
  const weights = await loadPublicCourtWeights();
  return toolDataResult(
    courtCatalog({
      country,
      courts,
      tierOf: (court) => courtTierLabelFromMap(weights, court, country),
    }),
  );
};

export const CASE_LAW_COURT_CATALOG_TOOL_SET = defineMcpToolSet(
  [
    READ_CASE_LAW_COURTS_TOOL_DEFINITION,
  ] as const satisfies readonly McpToolDefinition[],
  { read_case_law_courts: listCourtsTool },
  {
    read_case_law_courts: defineMcpToolOutput(
      CASE_LAW_COURT_CATALOG_PROJECTION,
    ),
  },
);

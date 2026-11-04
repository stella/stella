import { Result } from "better-result";
import * as v from "valibot";

import {
  COURT_TIER_LABELS,
  type CourtTierLabel,
} from "@stll/api-contract/case-law-court-tiers";
import { compareCodeUnit } from "@stll/collation";

import { readAdmittedCourtNames } from "@/api/handlers/case-law/decisions/shelf-courts";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { courtTierLabelFromMap } from "@/api/lib/case-law/court-weights";
import { readNonRedistributableCaseLawSourceIds } from "@/api/lib/case-law/non-redistributable-sources";
import { loadPublicCourtWeights } from "@/api/lib/case-law/public-case-law-config";
import { CASE_LAW_COURT_CATALOG_PROJECTION } from "@/api/lib/chat/case-law-court-catalog-projection";
import { runBoundedRequestStep } from "@/api/lib/load/request-latency-budget";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  READ_CASE_LAW_COURTS_INPUT_NORMALIZATION,
  READ_CASE_LAW_COURTS_TOOL,
  readCaseLawCourtsArgsSchema,
} from "@/api/mcp/case-law-court-catalog-input";
import {
  loadCaseLawCourtNames,
  storedCourtIdentities,
} from "@/api/mcp/case-law-court-filter";
import type { McpRequestContext } from "@/api/mcp/context";
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
 *
 * Only spellings in `admitted` are listed: a court whose every source the
 * redistribution policy withholds is never named, and a withheld spelling of
 * an admitted court is not offered as one of its aliases.
 */
export const courtCatalog = ({
  admitted,
  country,
  courts,
  tierOf,
}: {
  admitted: ReadonlySet<string>;
  country: string;
  courts: readonly string[];
  tierOf: (court: string) => CourtTierLabel;
}): CourtCatalog => {
  const servable = courts.filter((court) => admitted.has(court));
  const entries = storedCourtIdentities(country, servable).map(
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
  const [courts, admitted] = await Promise.all([
    loadCaseLawCourtNames(context, country),
    loadAdmittedCourtNames(context, country),
  ]);
  // Fails closed: without the admitted set the list could name a court
  // whose every source is withheld, so it lists nothing instead.
  if (courts === null || admitted === null) {
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
      admitted,
      country,
      courts,
      tierOf: (court) => courtTierLabelFromMap(weights, court, country),
    }),
  );
};

/** Same sub-budget as the court-filter vocabulary it is read beside. */
const ADMITTED_COURTS_READ_BUDGET_MS = 1500;

const ADMITTED_COURTS_SINK = failureSink({
  event: "mcp.case_law.admitted_courts_unavailable",
  expected: [],
});

/**
 * The country's courts a public surface may name, under the same source
 * policy search_case_law reads, or null when either read fails or runs out.
 */
const loadAdmittedCourtNames = async (
  context: McpRequestContext,
  country: string,
): Promise<ReadonlySet<string> | null> => {
  const read =
    context.testDependencies?.readAdmittedCaseLawCourtNames ??
    readPublicAdmittedCourtNames;
  const admitted = await runBoundedRequestStep(
    async () => await read(country),
    {
      label: "case-law-admitted-courts",
      budgetMs: ADMITTED_COURTS_READ_BUDGET_MS,
    },
  );
  if (admitted.status === "complete") {
    return admitted.value;
  }
  observeFailure(admitted.error, { sink: ADMITTED_COURTS_SINK });
  return null;
};

const readPublicAdmittedCourtNames = async (
  country: string,
): Promise<ReadonlySet<string>> => {
  const excluded = await readNonRedistributableCaseLawSourceIds();
  if (Result.isError(excluded)) {
    return await Promise.reject(excluded.error);
  }
  return await readAdmittedCourtNames({
    caseLawDb: caseLawPublicReadDb,
    country,
    excludedSourceIds: excluded.value,
  });
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

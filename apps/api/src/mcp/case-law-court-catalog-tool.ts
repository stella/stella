import { Result } from "better-result";
import * as v from "valibot";

import {
  COURT_TIER_LABELS,
  type CourtTierLabel,
} from "@stll/api-contract/case-law-court-tiers";
import { compareCodeUnit } from "@stll/collation";

import { readAdmittedCourtPage } from "@/api/handlers/case-law/decisions/shelf-courts";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { courtTierLabelFromMap } from "@/api/lib/case-law/court-weights";
import { readNonRedistributableCaseLawSourceIds } from "@/api/lib/case-law/non-redistributable-sources";
import { loadPublicCourtWeights } from "@/api/lib/case-law/public-case-law-config";
import { CASE_LAW_COURT_CATALOG_PROJECTION } from "@/api/lib/chat/case-law-court-catalog-projection";
import { LIMITS } from "@/api/lib/limits";
import { runBoundedRequestStep } from "@/api/lib/load/request-latency-budget";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import {
  decodePaginationCursor,
  encodePaginationCursor,
} from "@/api/lib/pagination";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import {
  LIST_CASE_LAW_COURTS_INPUT_NORMALIZATION,
  LIST_CASE_LAW_COURTS_READ_BUDGET_MS,
  LIST_CASE_LAW_COURTS_TOOL,
  listCaseLawCourtsArgsSchema,
} from "@/api/mcp/case-law-court-catalog-input";
import { storedCourtIdentities } from "@/api/mcp/case-law-court-filter";
import type { McpRequestContext } from "@/api/mcp/context";
import { defineMcpToolSet } from "@/api/mcp/tool-types";
import type {
  McpToolDefinition,
  TypedMcpToolHandler,
} from "@/api/mcp/tool-types";
import {
  invalidCursorResult,
  structuredErrorResult,
  toolDataResult,
  validationErrorResult,
} from "@/api/mcp/tool-utils";
import {
  defineMcpToolOutput,
  defineValibotMcpTool,
} from "@/api/mcp/valibot-tool-definition";
import { openMcpRead } from "@/api/mcp/write-tool-authority";

const LIST_CASE_LAW_COURTS_TOOL_DEFINITION = defineValibotMcpTool({
  consumesServices: false,
  access: "read",
  permissions: openMcpRead("public case-law corpus"),
  readClass: "public",
  anonymized: { exposure: "passthrough" },
  feature: "FEATURE_PUBLIC_LAW",
  scope: "stella:read",
  name: LIST_CASE_LAW_COURTS_TOOL,
  annotations: {
    title: "List case-law courts",
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  description:
    "Widget-only: one page of a country's courts, by name, for the search court filter.",
  inputSchema: listCaseLawCourtsArgsSchema,
  inputNormalization: LIST_CASE_LAW_COURTS_INPUT_NORMALIZATION,
  _meta: { ui: { visibility: ["app"] } },
});

type CourtCatalog = v.InferInput<typeof CASE_LAW_COURT_CATALOG_PROJECTION>;

/**
 * One page of courts as the search's court filter reads it: a court the
 * corpus spells several ways is listed once, under the spelling the filter
 * maps every other spelling onto, grouped by tier, apex first. The page is a
 * run of stored names in code-unit order, so a caller paging on merges pages
 * by appending; two spellings of one court that fall on either side of a page
 * boundary are listed once on each page. Counts are left to the caller, which
 * has them for the result set it is narrowing.
 */
export const courtCatalogPage = ({
  country,
  courts,
  nextCursor,
  tierOf,
}: {
  country: string;
  courts: readonly string[];
  nextCursor: string | null;
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
    nextCursor,
  };
};

/** The last court of a page, which the next page starts after. */
export const encodeCourtCursor = (court: string): string =>
  encodePaginationCursor([court]);

const decodeCourtCursor = (cursor: string): string | null => {
  const parts = decodePaginationCursor(cursor);
  const court = parts?.at(0);
  return parts?.length === 1 && typeof court === "string" ? court : null;
};

const listCourtsTool: TypedMcpToolHandler<CourtCatalog> = async ({
  args,
  context,
}) => {
  const parsed = v.safeParse(listCaseLawCourtsArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const { country, cursor } = parsed.output;
  const limit = normalizeTenantPageLimit(
    parsed.output.limit ?? LIMITS.mcpListPageSizeMax,
  );
  const after = cursor === undefined ? null : decodeCourtCursor(cursor);
  if (cursor !== undefined && after === null) {
    return invalidCursorResult({ cursor, tool: LIST_CASE_LAW_COURTS_TOOL });
  }
  const page = await loadAdmittedCourtPage(context, { country, after, limit });
  // Fails closed: the page is the policy-filtered read or nothing, never an
  // unfiltered list that could name a court whose every source is withheld.
  if (page === null) {
    return structuredErrorResult({
      code: "public_read_timeout",
      message: "The court list could not be read in time.",
      hint: "Retry the call.",
      retryable: true,
    });
  }
  const last = page.courts.at(-1);
  const weights = await loadPublicCourtWeights();
  return toolDataResult(
    courtCatalogPage({
      country,
      courts: page.courts,
      nextCursor:
        page.more && last !== undefined ? encodeCourtCursor(last) : null,
      tierOf: (court) => courtTierLabelFromMap(weights, court, country),
    }),
  );
};

const ADMITTED_COURTS_SINK = failureSink({
  event: "mcp.case_law.admitted_courts_unavailable",
  expected: [],
});

type AdmittedCourtPageRequest = {
  country: string;
  after: string | null;
  limit: number;
};
type AdmittedCourtPage = { courts: string[]; more: boolean };

/**
 * One page of the country's courts a public surface may name, under the same
 * source policy search_case_law reads, or null when a read fails or runs out.
 */
const loadAdmittedCourtPage = async (
  context: McpRequestContext,
  request: AdmittedCourtPageRequest,
): Promise<AdmittedCourtPage | null> => {
  const read =
    context.testDependencies?.readAdmittedCaseLawCourtPage ??
    readPublicAdmittedCourtPage;
  const page = await runBoundedRequestStep(async () => await read(request), {
    label: "case-law-admitted-courts",
    budgetMs: LIST_CASE_LAW_COURTS_READ_BUDGET_MS,
  });
  if (page.status === "complete") {
    return page.value;
  }
  observeFailure(page.error, { sink: ADMITTED_COURTS_SINK });
  return null;
};

const readPublicAdmittedCourtPage = async (
  request: AdmittedCourtPageRequest,
): Promise<AdmittedCourtPage> => {
  const excluded = await readNonRedistributableCaseLawSourceIds();
  if (Result.isError(excluded)) {
    return await Promise.reject(excluded.error);
  }
  return await readAdmittedCourtPage({
    caseLawDb: caseLawPublicReadDb,
    excludedSourceIds: excluded.value,
    ...request,
  });
};

export const CASE_LAW_COURT_CATALOG_TOOL_SET = defineMcpToolSet(
  [
    LIST_CASE_LAW_COURTS_TOOL_DEFINITION,
  ] as const satisfies readonly McpToolDefinition[],
  { list_case_law_courts: listCourtsTool },
  {
    list_case_law_courts: defineMcpToolOutput(
      CASE_LAW_COURT_CATALOG_PROJECTION,
    ),
  },
);

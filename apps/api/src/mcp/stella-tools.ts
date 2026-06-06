import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as v from "valibot";

import { COUNTRY_CODES } from "@stll/country-codes";
import { roles } from "@stll/permissions";

import type { PracticeJurisdiction } from "@/api/db/schema";
import { readDecisionHandler } from "@/api/handlers/case-law/decisions/read-by-id";
import { searchDecisionsHandler } from "@/api/handlers/case-law/decisions/search";
import { hasUsableAst } from "@/api/handlers/case-law/document-ast";
import {
  normalizePracticeJurisdictions,
  upsertPracticeJurisdictions,
} from "@/api/handlers/organization-settings/practice-jurisdictions";
import { readWorkspaceHandler } from "@/api/handlers/workspaces/read-by-id";
import { readOverviewHandler } from "@/api/handlers/workspaces/read-overview";
import { readWorkspaceContactsHandler } from "@/api/handlers/workspaces/workspace-contacts-read";
import { caseLawPublicReadDb } from "@/api/lib/case-law-public-read-db";
import { decryptContent } from "@/api/lib/content-encryption";
import { LIMITS } from "@/api/lib/limits";
import {
  brandPersistedCaseLawDecisionId,
  brandPersistedCaseLawSourceId,
  brandPersistedContactId,
  brandPersistedEntityId,
} from "@/api/lib/safe-id-boundaries";
import { getSearchProvider } from "@/api/lib/search/provider";
import type { McpRequestContext } from "@/api/mcp/context";
import type { McpToolDefinition, McpToolHandler } from "@/api/mcp/tool-types";
import {
  buildCaseLawDecisionUrl,
  DEFAULT_LIST_LIMIT,
  DEFAULT_SEARCH_LIMIT,
  ensureWorkspaceAccess,
  enumProp,
  errorResult,
  getAppBaseUrl,
  intProp,
  MAX_LIST_LIMIT,
  MAX_SEARCH_LIMIT,
  parseOptionalEnum,
  parseOptionalLimit,
  parseRequiredString,
  stringProp,
  textResult,
} from "@/api/mcp/tool-utils";

const MCP_CONTENT_MAX_CHARS = 8000;
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/u;

type StellaToolName =
  | "get_matter_overview"
  | "list_matters"
  | "read_case_law_decision"
  | "read_contact"
  | "read_content_across_matters"
  | "search_case_law"
  | "search_across_matters"
  | "set_practice_jurisdictions";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export const STELLA_TOOL_DEFINITIONS = [
  {
    annotations: { readOnlyHint: true },
    description:
      "List the matters you can access. Use this first when the user does not " +
      "name a matter explicitly or when you need matter IDs for follow-up tools.",
    inputSchema: {
      type: "object",
      properties: {
        status: enumProp("Filter by matter status", ["active", "all"]),
        limit: intProp("Max matters to return", {
          min: 1,
          max: MAX_LIST_LIMIT,
        }),
      },
    },
    name: "list_matters",
    scope: "stella:read",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "Get a compact overview of a matter including counts, recent entities, " +
      "and linked contacts. Use this to orient yourself before drilling in.",
    inputSchema: {
      type: "object",
      properties: {
        matter_id: stringProp("Matter/workspace ID"),
      },
      required: ["matter_id"],
    },
    name: "get_matter_overview",
    scope: "stella:read",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "Search across all accessible matters. Use this when the user explicitly " +
      "asks to search outside a single matter or you do not yet know the right matter.",
    inputSchema: {
      type: "object",
      properties: {
        query: stringProp("Search query", {
          maxLength: LIMITS.searchQueryMaxLength,
        }),
        limit: intProp("Max results to return", {
          min: 1,
          max: MAX_SEARCH_LIMIT,
        }),
      },
      required: ["query"],
    },
    name: "search_across_matters",
    scope: "stella:search",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "Search the shared case-law corpus. Supports free-text search plus " +
      "optional filters such as court, country, language, date range, and " +
      "decision type.",
    inputSchema: {
      type: "object",
      properties: {
        query: stringProp("Search query", {
          maxLength: LIMITS.searchQueryMaxLength,
        }),
        limit: intProp("Max results to return", {
          min: 1,
          max: MAX_SEARCH_LIMIT,
        }),
        cursor: stringProp(
          "Opaque cursor from a previous search_case_law call",
          { maxLength: 128 },
        ),
        court: stringProp("Filter by court name", { maxLength: 512 }),
        country: stringProp("Filter by country code", { maxLength: 3 }),
        language: stringProp("Filter by language code", { maxLength: 8 }),
        decision_type: stringProp("Filter by decision type", {
          maxLength: 128,
        }),
        source_id: stringProp("Filter by source ID", { maxLength: 36 }),
        date_from: stringProp(
          "Filter decisions from this ISO date (YYYY-MM-DD)",
          { maxLength: 10 },
        ),
        date_to: stringProp(
          "Filter decisions up to this ISO date (YYYY-MM-DD)",
          { maxLength: 10 },
        ),
      },
      required: ["query"],
    },
    name: "search_case_law",
    scope: "stella:search",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "Read extracted text from a document found anywhere in your accessible " +
      "matters. Use after search_across_matters.",
    inputSchema: {
      type: "object",
      properties: {
        entity_id: stringProp("Entity ID"),
      },
      required: ["entity_id"],
    },
    name: "read_content_across_matters",
    scope: "stella:read",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "Read a single case-law decision by its decision ID. Returns metadata, " +
      "plain text, citation links, and source URLs.",
    inputSchema: {
      type: "object",
      properties: {
        decision_id: stringProp("Case-law decision ID"),
      },
      required: ["decision_id"],
    },
    name: "read_case_law_decision",
    scope: "stella:read",
  },
  {
    annotations: { readOnlyHint: true },
    description:
      "Read a contact by ID. Use this after matter overview or entity metadata " +
      "surfaces a contact the user wants to inspect more closely.",
    inputSchema: {
      type: "object",
      properties: {
        contact_id: stringProp("Contact ID"),
      },
      required: ["contact_id"],
    },
    name: "read_contact",
    scope: "stella:read",
  },
  {
    description:
      "Set the practice jurisdictions for the user's stella organization. " +
      "Call this when the org's practice jurisdictions are empty (e.g., the " +
      "user signed up via an OAuth client and skipped onboarding). Pass an " +
      "array of {countryCode, isPrimary}; exactly one entry should be primary.",
    inputSchema: {
      type: "object",
      properties: {
        jurisdictions: {
          type: "array",
          description:
            "Practice jurisdictions for this organization. countryCode is an " +
            "ISO 3166-1 alpha-2 code; exactly one entry should set isPrimary " +
            "to true.",
          minItems: 1,
          maxItems: LIMITS.practiceJurisdictionsPerOrganization,
          items: {
            type: "object",
            properties: {
              countryCode: {
                type: "string",
                description: "ISO 3166-1 alpha-2 country code",
                enum: [...COUNTRY_CODES],
              },
              isPrimary: {
                type: "boolean",
                description:
                  "Whether this is the organization's primary jurisdiction",
              },
            },
            required: ["countryCode", "isPrimary"],
          },
        },
      },
      required: ["jurisdictions"],
    },
    name: "set_practice_jurisdictions",
    scope: "stella:onboarding",
  },
] as const satisfies readonly McpToolDefinition[];

const loadPracticeJurisdictions = async (
  context: McpRequestContext,
): Promise<readonly PracticeJurisdiction[]> => {
  const row = await context.scopedDb((tx) =>
    tx.query.organizationSettings.findFirst({
      where: { organizationId: { eq: context.organizationId } },
      columns: { practiceJurisdictions: true },
    }),
  );
  return row?.practiceJurisdictions ?? [];
};

const buildOnboardingHintText = () =>
  `Your stella organization has not configured its practice jurisdictions ` +
  `yet. Call \`set_practice_jurisdictions\` (input: array of ` +
  `\`{ countryCode, isPrimary }\`) to enable jurisdiction-aware tools, or ` +
  `have the user complete onboarding at ${getAppBaseUrl()}.`;

const withOnboardingHintIfApplicable = async ({
  context,
  isEmpty,
  result,
}: {
  context: McpRequestContext;
  isEmpty: boolean;
  result: CallToolResult;
}): Promise<CallToolResult> => {
  if (!isEmpty) {
    return result;
  }
  const jurisdictions = await loadPracticeJurisdictions(context);
  if (jurisdictions.length > 0) {
    return result;
  }
  return {
    ...result,
    content: [
      ...result.content,
      { type: "text", text: buildOnboardingHintText() },
    ],
  };
};

const handleListMattersTool: McpToolHandler = async ({ args, context }) => {
  const status = parseOptionalEnum({
    args,
    defaultValue: "active",
    key: "status",
    values: ["active", "all"] as const,
  });
  if (typeof status !== "string") {
    return status;
  }

  const limit = parseOptionalLimit({
    args,
    defaultValue: DEFAULT_LIST_LIMIT,
    key: "limit",
    max: MAX_LIST_LIMIT,
  });
  if (typeof limit !== "number") {
    return limit;
  }

  const matters = await context.scopedDb((tx) =>
    tx.query.workspaces.findMany({
      where: {
        organizationId: { eq: context.organizationId },
        ...(status === "all" ? {} : { status }),
      },
      columns: {
        id: true,
        name: true,
        reference: true,
        status: true,
        lastActivityAt: true,
        createdAt: true,
      },
      orderBy: { lastActivityAt: "desc" },
      limit,
    }),
  );

  const result = textResult({
    matters: matters.map((matter) => ({
      id: matter.id,
      name: matter.name,
      reference: matter.reference,
      status: matter.status,
      lastActivityAt: matter.lastActivityAt.toISOString(),
      createdAt: matter.createdAt.toISOString(),
    })),
    totalCountLimit: LIMITS.workspacesCount,
  });

  return await withOnboardingHintIfApplicable({
    context,
    isEmpty: matters.length === 0,
    result,
  });
};

const handleGetMatterOverviewTool: McpToolHandler = async ({
  args,
  context,
}) => {
  const matterId = parseRequiredString(args, "matter_id");
  if (typeof matterId !== "string") {
    return matterId;
  }

  const workspaceId = ensureWorkspaceAccess({
    context,
    workspaceId: matterId,
  });
  if (!workspaceId) {
    return errorResult("Matter not found or not accessible");
  }

  const [workspace, overview, contacts] = await Promise.all([
    readWorkspaceHandler({
      organizationId: context.organizationId,
      scopedDb: context.scopedDb,
      workspaceId,
    }),
    readOverviewHandler({
      scopedDb: context.scopedDb,
      workspaceId,
    }),
    readWorkspaceContactsHandler({
      scopedDb: context.scopedDb,
      workspaceId,
    }),
  ]);

  if (typeof workspace !== "object" || !("name" in workspace)) {
    return errorResult("Matter not found or not accessible");
  }

  return textResult({
    matter: {
      id: workspace.id,
      name: workspace.name,
      reference: workspace.reference,
      status: workspace.status,
      clientName: workspace.client?.displayName ?? null,
    },
    overview,
    contacts: contacts.flatMap((workspaceContact) => {
      if (!workspaceContact.contact) {
        return [];
      }
      return [
        {
          contactId: workspaceContact.contact.id,
          displayName: workspaceContact.contact.displayName,
          role: workspaceContact.role,
          type: workspaceContact.contact.type,
        },
      ];
    }),
  });
};

const handleSearchAcrossMattersTool: McpToolHandler = async ({
  args,
  context,
}) => {
  const query = parseRequiredString(args, "query", {
    maxLength: LIMITS.searchQueryMaxLength,
  });
  if (typeof query !== "string") {
    return query;
  }

  const limit = parseOptionalLimit({
    args,
    defaultValue: DEFAULT_SEARCH_LIMIT,
    key: "limit",
    max: MAX_SEARCH_LIMIT,
  });
  if (typeof limit !== "number") {
    return limit;
  }

  const result = await getSearchProvider().search({
    query,
    organizationId: context.organizationId,
    workspaceIds: context.accessibleWorkspaceIds,
    limit,
  });

  return textResult({
    totalCount: result.totalCount,
    hits: result.hits.map((hit) => ({
      entityId: hit.entityId,
      workspaceId: hit.workspaceId,
      workspaceName: hit.workspaceName,
      name: hit.title,
      kind: hit.kind,
      headline: hit.headline,
    })),
  });
};

const parseOptionalStringArg = ({
  args,
  key,
  maxLength,
}: {
  args: Record<string, unknown>;
  key: string;
  maxLength?: number;
}): string | undefined | ReturnType<typeof errorResult> => {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    return errorResult(`Invalid parameter: ${key}. Expected a string`);
  }
  if (maxLength !== undefined && value.length > maxLength) {
    return errorResult(
      `Parameter ${key} exceeds maximum length of ${maxLength}`,
    );
  }
  return value;
};

const parseOptionalDateArg = ({
  args,
  key,
}: {
  args: Record<string, unknown>;
  key: string;
}): string | undefined | ReturnType<typeof errorResult> => {
  const value = parseOptionalStringArg({ args, key });
  if (typeof value !== "string") {
    return value;
  }
  if (!ISO_DATE_PATTERN.test(value)) {
    return errorResult(
      `Invalid parameter: ${key}. Expected an ISO date in YYYY-MM-DD format`,
    );
  }
  const parsed = new Date(value);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    return errorResult(
      `Invalid parameter: ${key}. Expected an ISO date in YYYY-MM-DD format`,
    );
  }
  return value;
};

const isToolErrorResult = (
  value: unknown,
): value is ReturnType<typeof errorResult> =>
  typeof value === "object" &&
  value !== null &&
  "isError" in value &&
  value.isError === true;

const getResultMessage = (value: unknown): string | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  if ("message" in value && typeof value.message === "string") {
    return value.message;
  }

  if (
    "response" in value &&
    typeof value.response === "object" &&
    value.response !== null &&
    "message" in value.response &&
    typeof value.response.message === "string"
  ) {
    return value.response.message;
  }

  return null;
};

type SearchCaseLawSuccess = Extract<
  Awaited<ReturnType<typeof searchDecisionsHandler>>,
  { hits: unknown[] }
>;

const isSearchCaseLawSuccess = (
  value: Awaited<ReturnType<typeof searchDecisionsHandler>>,
): value is SearchCaseLawSuccess =>
  typeof value === "object" && "hits" in value && Array.isArray(value.hits);

type ReadCaseLawDecisionSuccess = Extract<
  Awaited<ReturnType<typeof readDecisionHandler>>,
  { caseNumber: string; citationsFrom: unknown[]; citationsTo: unknown[] }
>;

const isReadCaseLawDecisionSuccess = (
  value: Awaited<ReturnType<typeof readDecisionHandler>>,
): value is ReadCaseLawDecisionSuccess =>
  typeof value === "object" &&
  "caseNumber" in value &&
  typeof value.caseNumber === "string" &&
  "citationsFrom" in value &&
  Array.isArray(value.citationsFrom) &&
  "citationsTo" in value &&
  Array.isArray(value.citationsTo);

const toPlainDecisionText = (decision: {
  documentAst: unknown;
  fulltext: string | null;
}) => {
  if (typeof decision.fulltext === "string" && decision.fulltext.length > 0) {
    return decision.fulltext;
  }
  if (!hasUsableAst(decision.documentAst)) {
    return null;
  }
  return decision.documentAst.blocks
    .map((block) => block.plainText)
    .join("\n\n");
};

const toIsoDateString = (value: unknown): string | null => {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  return null;
};

const handleReadContentAcrossMattersTool: McpToolHandler = async ({
  args,
  context,
}) => {
  const rawEntityId = parseRequiredString(args, "entity_id");
  if (typeof rawEntityId !== "string") {
    return rawEntityId;
  }

  const entityId = brandPersistedEntityId(rawEntityId);

  if (context.accessibleWorkspaceIds.length === 0) {
    return errorResult("No extracted content available for this entity.");
  }

  const row = await context.scopedDb((tx) =>
    tx.query.extractedContent.findFirst({
      where: {
        entityId: { eq: entityId },
        organizationId: { eq: context.organizationId },
        workspaceId: { in: context.accessibleWorkspaceIds },
      },
      with: {
        entity: {
          columns: {
            kind: true,
            name: true,
            workspaceId: true,
          },
        },
      },
    }),
  );

  if (!row?.entity) {
    return errorResult("No extracted content available for this entity.");
  }

  const plaintext = await decryptContent(
    context.organizationId,
    row.ciphertext,
    row.iv,
  );
  const truncated = plaintext.length > MCP_CONTENT_MAX_CHARS;

  return textResult({
    charCount: row.charCount,
    entityId,
    kind: row.entity.kind,
    name: row.entity.name,
    text: truncated ? plaintext.slice(0, MCP_CONTENT_MAX_CHARS) : plaintext,
    truncated,
    workspaceId: row.entity.workspaceId,
  });
};

const handleSearchCaseLawTool: McpToolHandler = async ({ args, context }) => {
  const query = parseRequiredString(args, "query", {
    maxLength: LIMITS.searchQueryMaxLength,
  });
  if (typeof query !== "string") {
    return query;
  }

  const limit = parseOptionalLimit({
    args,
    defaultValue: DEFAULT_SEARCH_LIMIT,
    key: "limit",
    max: MAX_SEARCH_LIMIT,
  });
  if (typeof limit !== "number") {
    return limit;
  }

  const cursor = parseOptionalStringArg({
    args,
    key: "cursor",
    maxLength: 128,
  });
  if (isToolErrorResult(cursor)) {
    return cursor;
  }
  const court = parseOptionalStringArg({
    args,
    key: "court",
    maxLength: 512,
  });
  if (isToolErrorResult(court)) {
    return court;
  }
  const country = parseOptionalStringArg({
    args,
    key: "country",
    maxLength: 3,
  });
  if (isToolErrorResult(country)) {
    return country;
  }
  const language = parseOptionalStringArg({
    args,
    key: "language",
    maxLength: 8,
  });
  if (isToolErrorResult(language)) {
    return language;
  }
  const decisionType = parseOptionalStringArg({
    args,
    key: "decision_type",
    maxLength: 128,
  });
  if (isToolErrorResult(decisionType)) {
    return decisionType;
  }
  const sourceId = parseOptionalStringArg({
    args,
    key: "source_id",
    maxLength: 36,
  });
  if (isToolErrorResult(sourceId)) {
    return sourceId;
  }
  if (sourceId !== undefined && !UUID_PATTERN.test(sourceId)) {
    return errorResult("Invalid parameter: source_id. Expected a UUID");
  }
  const dateFrom = parseOptionalDateArg({ args, key: "date_from" });
  if (isToolErrorResult(dateFrom)) {
    return dateFrom;
  }
  const dateTo = parseOptionalDateArg({ args, key: "date_to" });
  if (isToolErrorResult(dateTo)) {
    return dateTo;
  }

  const result = await searchDecisionsHandler(
    {
      query,
      limit,
      ...(cursor === undefined ? {} : { cursor }),
      ...(court === undefined ? {} : { court }),
      ...(country === undefined ? {} : { country }),
      ...(language === undefined ? {} : { language }),
      ...(decisionType === undefined ? {} : { decisionType }),
      ...(sourceId === undefined
        ? {}
        : { sourceId: brandPersistedCaseLawSourceId(sourceId) }),
      ...(dateFrom === undefined ? {} : { dateFrom }),
      ...(dateTo === undefined ? {} : { dateTo }),
    },
    caseLawPublicReadDb,
  );

  const resultMessage = getResultMessage(result);
  if (resultMessage) {
    return errorResult(resultMessage);
  }
  if (!isSearchCaseLawSuccess(result)) {
    return errorResult("Case-law search failed");
  }

  const payload = textResult({
    facets: result.facets,
    nextCursor: result.nextCursor,
    results: result.hits.map((hit) => ({
      appUrl: buildCaseLawDecisionUrl({
        caseNumber: hit.caseNumber,
        country: hit.country,
        court: hit.court,
        decisionDate: hit.decisionDate,
        language: hit.language,
        languageAlternateCount: hit.languageAlternateCount,
        slug: hit.slug,
      }),
      caseNumber: hit.caseNumber,
      citationCount: hit.citationCount,
      country: hit.country,
      court: hit.court,
      decisionDate: hit.decisionDate,
      decisionId: hit.decisionId,
      decisionType: hit.decisionType,
      ecli: hit.ecli,
      language: hit.language,
      snippet: hit.headline,
      sourceUrl: hit.sourceUrl,
    })),
    totalCount: result.totalCount,
  });

  return await withOnboardingHintIfApplicable({
    context,
    isEmpty: result.hits.length === 0,
    result: payload,
  });
};

const handleReadCaseLawDecisionTool: McpToolHandler = async ({ args }) => {
  const decisionId = parseRequiredString(args, "decision_id");
  if (typeof decisionId !== "string") {
    return decisionId;
  }

  const result = await readDecisionHandler(
    brandPersistedCaseLawDecisionId(decisionId),
    caseLawPublicReadDb,
  );
  const resultMessage = getResultMessage(result);
  if (resultMessage) {
    return errorResult(resultMessage);
  }
  if (!isReadCaseLawDecisionSuccess(result)) {
    return errorResult("Decision not found");
  }

  return textResult({
    decision: {
      appUrl: buildCaseLawDecisionUrl({
        caseNumber: result.caseNumber,
        country: result.country,
        court: result.court,
        decisionDate: result.decisionDate,
        language: result.language,
        languageAlternates: result.languageAlternates,
        slug: result.slug,
      }),
      caseNumber: result.caseNumber,
      citationsFrom: result.citationsFrom.slice(0, 50),
      citationsFromTotal: result.citationsFrom.length,
      citationsTo: result.citationsTo.slice(0, 50),
      citationsToTotal: result.citationsTo.length,
      country: result.country,
      court: result.court,
      decisionDate: toIsoDateString(result.decisionDate),
      decisionId: result.id,
      decisionType: result.decisionType,
      documentUrl: result.documentUrl,
      ecli: result.ecli,
      language: result.language,
      metadata: result.metadata,
      source: result.source,
      sourceUrl: result.sourceUrl,
      text: toPlainDecisionText({
        documentAst: result.documentAst,
        fulltext: result.fulltext,
      }),
    },
  });
};

const handleReadContactTool: McpToolHandler = async ({ args, context }) => {
  const rawContactId = parseRequiredString(args, "contact_id");
  if (typeof rawContactId !== "string") {
    return rawContactId;
  }

  const contactId = brandPersistedContactId(rawContactId);

  const contact = await context.scopedDb((tx) =>
    tx.query.contacts.findFirst({
      where: {
        id: { eq: contactId },
        organizationId: { eq: context.organizationId },
      },
      columns: {
        id: true,
        type: true,
        displayName: true,
        firstName: true,
        lastName: true,
        organizationName: true,
        emails: true,
        phones: true,
      },
    }),
  );

  if (!contact) {
    return errorResult("Contact not found");
  }

  return textResult({
    contactId: contact.id,
    type: contact.type,
    displayName: contact.displayName,
    firstName: contact.firstName,
    lastName: contact.lastName,
    organizationName: contact.organizationName,
    emails: contact.emails ?? [],
    phones: contact.phones ?? [],
  });
};

const countryCodeSchema = v.picklist(COUNTRY_CODES);

const practiceJurisdictionInputSchema = v.strictObject({
  countryCode: countryCodeSchema,
  isPrimary: v.boolean(),
});

const setPracticeJurisdictionsArgsSchema = v.strictObject({
  jurisdictions: v.pipe(
    v.array(practiceJurisdictionInputSchema),
    v.minLength(1),
    v.maxLength(LIMITS.practiceJurisdictionsPerOrganization),
  ),
});

const handleSetPracticeJurisdictionsTool: McpToolHandler = async ({
  args,
  context,
}) => {
  const hasPermission = roles[context.memberRole].authorize({
    organizationSettings: ["update"],
  });
  if (!hasPermission.success) {
    return errorResult("Forbidden");
  }

  const parsed = v.safeParse(setPracticeJurisdictionsArgsSchema, args);
  if (!parsed.success) {
    return errorResult(
      "Invalid input: expected { jurisdictions: Array<{ countryCode: ISO 3166-1 alpha-2, isPrimary: boolean }> }",
    );
  }

  const primaryCount = parsed.output.jurisdictions.filter(
    (jurisdiction) => jurisdiction.isPrimary,
  ).length;
  if (primaryCount > 1) {
    return errorResult("Only one jurisdiction can be primary");
  }

  const practiceJurisdictions = normalizePracticeJurisdictions(
    parsed.output.jurisdictions,
  );

  await context.scopedDb(async (tx) => {
    await upsertPracticeJurisdictions({
      organizationId: context.organizationId,
      practiceJurisdictions,
      recordAuditEvent: context.recordAuditEvent,
      tx,
    });
  });

  return textResult({ practiceJurisdictions });
};

export const STELLA_TOOL_HANDLERS = {
  get_matter_overview: handleGetMatterOverviewTool,
  list_matters: handleListMattersTool,
  read_case_law_decision: handleReadCaseLawDecisionTool,
  read_contact: handleReadContactTool,
  read_content_across_matters: handleReadContentAcrossMattersTool,
  search_case_law: handleSearchCaseLawTool,
  search_across_matters: handleSearchAcrossMattersTool,
  set_practice_jurisdictions: handleSetPracticeJurisdictionsTool,
} satisfies Record<StellaToolName, McpToolHandler>;

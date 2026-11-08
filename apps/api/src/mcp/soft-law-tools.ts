import * as v from "valibot";

import { AGENT_INPUT_NORMALIZATION_KIND } from "@stll/agent-input";
import { apiDateSchema } from "@stll/api-contract/api-date";
import { GUIDANCE_KINDS } from "@stll/legal-ast/document-kind";

import {
  READ_GUIDANCE_PROJECTION,
  SEARCH_GUIDANCE_PROJECTION,
} from "@/api/lib/chat/soft-law-result-projections";
import {
  decodeSoftLawCursor,
  encodeSoftLawCursor,
  isSoftLawCursor,
  readServedSoftLaw,
  searchServedSoftLaw,
  SOFT_LAW_SEARCH_PAGE_SIZE_MAX,
} from "@/api/lib/legal-search/soft-law-read";
import {
  SOFT_LAW_READ_SURFACE,
  type SoftLawReadSurface,
} from "@/api/lib/legal-search/soft-law-serving";
import { LIMITS } from "@/api/lib/limits";
import { projectionPayload } from "@/api/lib/projection-totality";
import { normalizeTenantPageLimit } from "@/api/lib/rate-limit/action-size-limits";
import { brandPersistedSoftLawDocumentId } from "@/api/lib/safe-id-boundaries";
import type { McpRequestContext } from "@/api/mcp/context";
import {
  cursorInput,
  FILTER_NORMALIZATION,
  nullAsAbsent,
  uuidInputSchema,
} from "@/api/mcp/input-schemas";
import type {
  McpToolDefinition,
  McpToolHandler,
  TypedMcpToolHandler,
} from "@/api/mcp/tool-types";
import { defineMcpToolSet } from "@/api/mcp/tool-types";
import {
  DEFAULT_SEARCH_LIMIT,
  invalidCursorResult,
  isToolErrorResult,
  MCP_CONTENT_MAX_CHARS,
  notFoundResult,
  toolDataResult,
  validationErrorResult,
  windowTextByCursor,
} from "@/api/mcp/tool-utils";
import {
  defineChatProjectionMcpToolOutput,
  defineValibotMcpTool,
} from "@/api/mcp/valibot-tool-definition";
import { openMcpRead } from "@/api/mcp/write-tool-authority";

type SoftLawToolName = "search_guidance" | "read_guidance";

const SEARCH_GUIDANCE_TOOL = "search_guidance";
const READ_GUIDANCE_TOOL = "read_guidance";

const dateFilter = (description: string) =>
  v.optional(
    v.pipe(
      apiDateSchema,
      v.maxLength(LIMITS.isoDateLength),
      v.description(description),
    ),
  );

const searchGuidanceArgsSchema = nullAsAbsent(
  v.strictObject({
    query: v.pipe(
      v.string(),
      v.minLength(LIMITS.mcpNonEmptyMin),
      v.maxLength(LIMITS.searchQueryMaxLength),
      v.description("Words to find in the guidance title or text"),
    ),
    authority: v.optional(
      v.pipe(
        v.string(),
        v.minLength(LIMITS.mcpNonEmptyMin),
        v.maxLength(LIMITS.softLawAuthorityMaxLength),
        v.description(
          "Issuing authority, as returned in issuer.authority (for example eu-edpb)",
        ),
      ),
    ),
    jurisdiction: v.optional(
      v.pipe(
        v.string(),
        v.minLength(LIMITS.softLawJurisdictionMinLength),
        v.maxLength(LIMITS.softLawJurisdictionMaxLength),
        v.description("Jurisdiction code, for example CZE or EU"),
      ),
    ),
    kind: v.optional(
      v.pipe(v.picklist(GUIDANCE_KINDS), v.description("Document kind")),
    ),
    date_from: dateFilter("Issued on or after this ISO date (YYYY-MM-DD)"),
    date_to: dateFilter("Issued on or before this ISO date (YYYY-MM-DD)"),
    limit: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(LIMITS.mcpPageSizeMin),
        v.maxValue(SOFT_LAW_SEARCH_PAGE_SIZE_MAX),
        v.description(
          `Max results to return; defaults to ${DEFAULT_SEARCH_LIMIT}.`,
        ),
      ),
    ),
    cursor: cursorInput({
      description: `Opaque cursor from a previous ${SEARCH_GUIDANCE_TOOL} call`,
      issuedBy: isSoftLawCursor,
    }),
  }),
);

const readGuidanceArgsSchema = nullAsAbsent(
  v.strictObject({
    document_id: uuidInputSchema(
      `Guidance document id, as ${SEARCH_GUIDANCE_TOOL} returns it in documentId`,
    ),
    cursor: cursorInput({
      description: `Opaque cursor from a previous ${READ_GUIDANCE_TOOL} call, to continue long text`,
    }),
  }),
);

const SOFT_LAW_TOOL_DEFINITIONS = [
  defineValibotMcpTool({
    consumesServices: false,
    annotations: {
      title: "Search regulator guidance",
      destructiveHint: false,
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "Search regulator guidance (soft law): methodologies, opinions, guidelines, " +
      "recommendations, FAQs and similar documents issued by data-protection and " +
      "labour regulators. Results are guidance, never court decisions: for case law use " +
      "search_case_law. Each result carries documentClass, issuer, kind, reference, " +
      "issuedOn, validity, source_url and the attribution to show with it. Filter by " +
      "authority, jurisdiction, kind, date_from and date_to. A source served as metadata " +
      "only is matched on its title and has a null snippet. Totals are not counted; " +
      `page with cursor. Read a hit with ${READ_GUIDANCE_TOOL}.`,
    inputSchema: searchGuidanceArgsSchema,
    inputNormalization: {
      authority: FILTER_NORMALIZATION,
      jurisdiction: FILTER_NORMALIZATION,
      date_from: { kind: AGENT_INPUT_NORMALIZATION_KIND.date, bound: "start" },
      date_to: { kind: AGENT_INPUT_NORMALIZATION_KIND.date, bound: "end" },
    },
    access: "read",
    permissions: openMcpRead("public regulator guidance corpus"),
    readClass: "public",
    anonymized: { exposure: "passthrough" },
    feature: "FEATURE_PUBLIC_LAW",
    name: SEARCH_GUIDANCE_TOOL,
    scope: "stella:search",
  }),
  defineValibotMcpTool({
    consumesServices: false,
    annotations: {
      title: "Read regulator guidance",
      destructiveHint: false,
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "Read one regulator guidance document by document_id. It is guidance, not a " +
      "court decision. Returns the issuer, kind, reference, issue date, validity as " +
      "the publisher states it, source_url, the attribution and any conditions to " +
      "show with it, and its text. When you summarize this text, show " +
      "attribution.text and any attribution.summaryDisclaimer with the summary. " +
      "textState says why text is null: withheld_by_source_setting or not_extracted; " +
      "use source_url then. Pass nextCursor back as cursor to read more.",
    inputSchema: readGuidanceArgsSchema,
    access: "read",
    permissions: openMcpRead("public regulator guidance corpus"),
    readClass: "public",
    anonymized: { exposure: "passthrough" },
    feature: "FEATURE_PUBLIC_LAW",
    name: READ_GUIDANCE_TOOL,
    scope: "stella:read",
  }),
] as const satisfies readonly McpToolDefinition[];

/** In-app chat declares itself; every other caller of these tools is an MCP client. */
const surfaceOf = (context: McpRequestContext): SoftLawReadSurface =>
  context.softLawReadSurface ?? SOFT_LAW_READ_SURFACE.mcp;

const withPublisherLink = <T extends { publisherUrl: string | null }>({
  publisherUrl,
  ...rest
}: T) => ({ ...rest, source_url: publisherUrl });

const handleSearchGuidanceTool: TypedMcpToolHandler<
  v.InferInput<typeof SEARCH_GUIDANCE_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(searchGuidanceArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const { authority, cursor, date_from, date_to, jurisdiction, kind, query } =
    parsed.output;
  const offset = cursor === undefined ? 0 : decodeSoftLawCursor(cursor);
  if (offset === null) {
    return invalidCursorResult({
      cursor: cursor ?? "",
      tool: SEARCH_GUIDANCE_TOOL,
    });
  }
  const page = await (
    context.testDependencies?.searchServedSoftLaw ?? searchServedSoftLaw
  )({
    query,
    authority,
    jurisdiction,
    kind,
    dateFrom: date_from,
    dateTo: date_to,
    offset,
    limit: normalizeTenantPageLimit(
      parsed.output.limit ?? DEFAULT_SEARCH_LIMIT,
    ),
    surface: surfaceOf(context),
  });
  return toolDataResult(
    projectionPayload(SEARCH_GUIDANCE_PROJECTION, {
      nextCursor:
        page.nextOffset === null ? null : encodeSoftLawCursor(page.nextOffset),
      results: page.items.map(withPublisherLink),
    }),
  );
};

const handleReadGuidanceTool: TypedMcpToolHandler<
  v.InferInput<typeof READ_GUIDANCE_PROJECTION>
> = async ({ args, context }) => {
  const parsed = v.safeParse(readGuidanceArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const { cursor, document_id: documentId } = parsed.output;
  const document = await (
    context.testDependencies?.readServedSoftLaw ?? readServedSoftLaw
  )({
    documentId: brandPersistedSoftLawDocumentId(documentId),
    surface: surfaceOf(context),
  });
  if (document === null) {
    return notFoundResult(
      "Guidance document not found",
      `Find a served document with ${SEARCH_GUIDANCE_TOOL} and pass its documentId.`,
    );
  }
  const window =
    document.text === null
      ? null
      : windowTextByCursor({
          cursor,
          maxChars: MCP_CONTENT_MAX_CHARS,
          text: document.text,
        });
  if (isToolErrorResult(window)) {
    return window;
  }
  return toolDataResult(
    projectionPayload(READ_GUIDANCE_PROJECTION, {
      nextCursor: window?.nextCursor ?? null,
      guidance: {
        ...withPublisherLink(document),
        text: window?.text ?? null,
        truncated: window?.truncated ?? false,
      },
    }),
  );
};

export const SOFT_LAW_TOOL_HANDLERS = {
  search_guidance: handleSearchGuidanceTool,
  read_guidance: handleReadGuidanceTool,
} satisfies Record<SoftLawToolName, McpToolHandler>;

export const SOFT_LAW_TOOL_SET = defineMcpToolSet(
  SOFT_LAW_TOOL_DEFINITIONS,
  SOFT_LAW_TOOL_HANDLERS,
  {
    search_guidance: defineChatProjectionMcpToolOutput(
      SEARCH_GUIDANCE_PROJECTION,
    ),
    read_guidance: defineChatProjectionMcpToolOutput(READ_GUIDANCE_PROJECTION),
  },
);

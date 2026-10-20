import { panic, Result } from "better-result";
import * as v from "valibot";

import { AGENT_INPUT_NORMALIZATION_KIND } from "@stll/agent-input";
import { legalResolveResponseSchema } from "@stll/api-contract/legal-resolve";
import { CASE_LAW_RESULTS_RESOURCE_URI } from "@stll/mcp-apps/resource-uri";

import type { resolveDecision } from "@/api/handlers/legal-resolve/decision";
import type { resolveLawCitation } from "@/api/handlers/legal-resolve/law";
import { LAW_READ_SCOPE } from "@/api/handlers/legal-resolve/scope";
import { LIMITS } from "@/api/lib/limits";

import { defineMcpToolSet, definePublicReadTool } from "./tool-types";
import type { McpToolDefinition, PublicMcpToolHandler } from "./tool-types";
import {
  countryInputSchema,
  countryNormalization,
  nullAsAbsent,
  structuredErrorResult,
  toolDataResult,
  validationErrorResult,
} from "./tool-utils";
import {
  defineMcpToolOutput,
  defineValibotMcpTool,
} from "./valibot-tool-definition";

const defaultResolveDecision: typeof resolveDecision = async (...input) =>
  await (
    await import("@/api/handlers/legal-resolve/decision")
  ).resolveDecision(...input);
const defaultResolveLawCitation: typeof resolveLawCitation = async (...input) =>
  await (
    await import("@/api/handlers/legal-resolve/law")
  ).resolveLawCitation(...input);

const citationText = v.pipe(
  v.string(),
  v.nonEmpty(),
  v.maxLength(LIMITS.caseLawIdentifierMaxLength),
);
const lawCountrySchema = countryInputSchema(
  "Country of the cited law; alpha-2, alpha-3 or country name. Unrecognized or unsupported countries return country_unavailable.",
);
const decisionCountrySchema = countryInputSchema(
  "Country of the deciding court; alpha-2, alpha-3 or country name. Unrecognized or unsupported countries return country_unavailable.",
);
const resolveDecisionArgsSchema = nullAsAbsent(
  v.strictObject({
    country: decisionCountrySchema,
    identifier: v.pipe(
      citationText,
      v.description(
        "One exact docket as the court wrote it, including its sheet, or ECLI. Use search_case_law for a description of a case.",
      ),
    ),
  }),
);
const resolveLawArgsSchema = nullAsAbsent(
  v.strictObject({
    country: lawCountrySchema,
    source: v.pipe(
      v.variant("type", [
        v.strictObject({
          type: v.pipe(
            v.literal("citation"),
            v.description("Resolve a written citation."),
          ),
          citation: v.pipe(
            citationText,
            v.description(
              "Statute citation as written, e.g. zákon č. 89/2012 Sb.",
            ),
          ),
        }),
        v.strictObject({
          type: v.pipe(
            v.literal("structured"),
            v.description("Resolve a gazette collection, year and act number."),
          ),
          collection: v.pipe(
            citationText,
            v.description("Gazette collection, e.g. sb."),
          ),
          year: v.pipe(
            citationText,
            v.description("Publication year, e.g. 2012."),
          ),
          number: v.pipe(citationText, v.description("Act number, e.g. 89.")),
        }),
      ]),
      v.description(
        "Choose citation for written text or structured for gazette identity.",
      ),
    ),
    section: v.pipe(
      citationText,
      v.description("Section number, with optional §, e.g. 1729 or § 5a."),
    ),
    as_of: v.optional(
      v.pipe(
        v.string(),
        v.isoDate(),
        v.description(
          "Expression date YYYY-MM-DD; omit for the current expression.",
        ),
      ),
    ),
  }),
);

const common = {
  consumesServices: false,
  access: "read",
  authority: {
    kind: "public",
    reason: "Reads published or capability metadata.",
  },
  readClass: "public",
  anonymized: { exposure: "passthrough" },
  feature: "FEATURE_PUBLIC_LAW",
  scope: LAW_READ_SCOPE,
  inputNormalization: {
    country: {
      ...countryNormalization({ spelling: "alpha-3" }),
      invalidValueDisposition: "handler-owned",
    },
  },
} as const;

const RAW_LEGAL_RESOLVE_TOOL_DEFINITIONS = [
  defineValibotMcpTool({
    ...common,
    name: "resolve_case_law_decision",
    annotations: {
      title: "Resolve a case-law citation",
      destructiveHint: false,
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "Resolve one exact docket (including its sheet) or ECLI; use search_case_law for descriptions. Returns the legal resolve API envelope: resolved carries decisionId, readerUrl and readable, licence-withheld or unavailable text. Readable text has extent complete or partial; for partial call read_case_law_decision with decisionId to continue, or open readerUrl. Ambiguous lists candidates without choosing; open only an explicitly chosen readerUrl. Incomplete_identifier lists missing parts: supply them and retry. Not_found names the reason: use search_case_law. Country_unavailable: unrecognized or unsupported country; use case_law_coverage. Add missing stella:search for search or stella:read for the reader and coverage through OAuth consent before recovery calls.",
    inputSchema: resolveDecisionArgsSchema,
    _meta: {
      ui: {
        resourceUri: CASE_LAW_RESULTS_RESOURCE_URI,
        visibility: ["model", "app"],
      },
    },
  }),
  defineValibotMcpTool({
    ...common,
    name: "resolve_law_citation",
    annotations: {
      title: "Resolve a statute provision",
      destructiveHint: false,
      readOnlyHint: true,
      openWorldHint: false,
    },
    description:
      "Resolve one statute provision from a citation or structured gazette identity and section. Supports Czech statutes; unrecognized or unsupported countries return country_unavailable. Omit as_of for the current expression. Returns the legal resolve API envelope: resolved carries a provision, readerUrl, force dates, versionStatus and blocks; not_found names unknown_document or unknown_section; incomplete_identifier lists missing parts; ambiguous lists candidates without choosing. Open through readerUrl; supply missing parts and retry. For unknown_document use search_legislation; for unknown_section search then read_statute_provisions. Add missing stella:search (search) or stella:read (read) through OAuth consent before recovery calls.",
    inputSchema: resolveLawArgsSchema,
    inputNormalization: {
      ...common.inputNormalization,
      as_of: { kind: AGENT_INPUT_NORMALIZATION_KIND.date, bound: "start" },
    },
  }),
] as const;

type ResolveData = v.InferOutput<typeof legalResolveResponseSchema>;
const handleResolveDecision: PublicMcpToolHandler<ResolveData> = async ({
  args,
  context,
}) => {
  const parsed = v.safeParse(resolveDecisionArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const admission = context.testDependencies?.admitLawRead?.({
    organizationId: context.lawReadAdmission.organizationId,
  });
  if (admission !== undefined && Result.isError(admission)) {
    return structuredErrorResult({
      code: "feature_disabled",
      message: "This tool is unavailable on this deployment.",
      retryable: false,
    });
  }
  const { country, identifier } = parsed.output;
  return toolDataResult(
    await (context.testDependencies?.resolveDecision ?? defaultResolveDecision)(
      { admission: context.lawReadAdmission, country, identifier },
    ),
  );
};
const handleResolveLaw: PublicMcpToolHandler<ResolveData> = async ({
  args,
  context,
}) => {
  const parsed = v.safeParse(resolveLawArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const admission = context.testDependencies?.admitLawRead?.({
    organizationId: context.lawReadAdmission.organizationId,
  });
  if (admission !== undefined && Result.isError(admission)) {
    return structuredErrorResult({
      code: "feature_disabled",
      message: "This tool is unavailable on this deployment.",
      retryable: false,
    });
  }
  const { country, source, section, as_of: asOf } = parsed.output;
  switch (source.type) {
    case "citation":
      return toolDataResult(
        await (
          context.testDependencies?.resolveLawCitation ??
          defaultResolveLawCitation
        )({
          admission: context.lawReadAdmission,
          country,
          input: { citation: source.citation, section, asOf },
        }),
      );
    case "structured":
      return toolDataResult(
        await (
          context.testDependencies?.resolveLawCitation ??
          defaultResolveLawCitation
        )({
          admission: context.lawReadAdmission,
          country,
          input: {
            collection: source.collection,
            year: source.year,
            number: source.number,
            section,
            asOf,
          },
        }),
      );
    default:
      source satisfies never;
      return panic("Unknown statute citation source");
  }
};

export const LEGAL_RESOLVE_TOOL_HANDLERS = {
  resolve_case_law_decision: handleResolveDecision,
  resolve_law_citation: handleResolveLaw,
};
const LEGAL_RESOLVE_TOOL_DEFINITIONS = [
  definePublicReadTool(
    RAW_LEGAL_RESOLVE_TOOL_DEFINITIONS[0],
    handleResolveDecision,
  ),
  definePublicReadTool(RAW_LEGAL_RESOLVE_TOOL_DEFINITIONS[1], handleResolveLaw),
] as const satisfies readonly McpToolDefinition[];
export const LEGAL_RESOLVE_TOOL_SET = defineMcpToolSet(
  LEGAL_RESOLVE_TOOL_DEFINITIONS,
  LEGAL_RESOLVE_TOOL_HANDLERS,
  {
    resolve_case_law_decision: defineMcpToolOutput(legalResolveResponseSchema),
    resolve_law_citation: defineMcpToolOutput(legalResolveResponseSchema),
  },
);

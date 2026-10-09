import { panic, Result } from "better-result";
import * as v from "valibot";

import { AGENT_INPUT_NORMALIZATION_KIND } from "@stll/agent-input";
import { legalResolveResponseSchema } from "@stll/api-contract/legal-resolve";

import type { admitLawRead } from "@/api/handlers/legal-resolve/admission";
import type { resolveDecision } from "@/api/handlers/legal-resolve/decision";
import type { resolveLawCitation } from "@/api/handlers/legal-resolve/law";
import { LAW_READ_SCOPE } from "@/api/handlers/legal-resolve/scope";
import { LIMITS } from "@/api/lib/limits";

import { CASE_LAW_RESULTS_RESOURCE_URI } from "./apps/resource-uri";
import { defineMcpToolSet } from "./tool-types";
import type { TypedMcpToolHandler } from "./tool-types";
import {
  countryInputSchema,
  countryNormalization,
  nullAsAbsent,
  structuredErrorResult,
  featureDisabledHint,
  MCP_UPSTREAM_UNAVAILABLE_HINT,
  toolDataResult,
  validationErrorResult,
} from "./tool-utils";
import {
  defineMcpToolOutput,
  defineValibotMcpTool,
} from "./valibot-tool-definition";

const defaultAdmitLawRead: typeof admitLawRead = async (input) =>
  await (
    await import("@/api/handlers/legal-resolve/admission")
  ).admitLawRead(input);

type AdmissionFailure = Extract<
  Awaited<ReturnType<typeof admitLawRead>>,
  { error: unknown }
>["error"];

const ADMISSION_ERRORS = {
  missing_scope: {
    code: "feature_disabled",
    message: "Public law is not enabled on this deployment.",
    hint: featureDisabledHint("FEATURE_PUBLIC_LAW"),
    retryable: false,
  },
  not_entitled: {
    code: "permission_denied",
    message: "This organization does not have public-law access.",
    hint: "Ask an organization administrator to enable public-law access, then retry.",
    retryable: false,
  },
  access_unavailable: {
    code: "upstream_unavailable",
    message: "Public-law access could not be checked.",
    hint: MCP_UPSTREAM_UNAVAILABLE_HINT,
    retryable: true,
  },
} as const satisfies Record<
  AdmissionFailure["type"],
  Parameters<typeof structuredErrorResult>[0]
>;

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
const countrySchema = countryInputSchema(
  "Country of the cited law; alpha-2, alpha-3 or country name. Unsupported countries return country_unavailable.",
);
const resolveDecisionArgsSchema = nullAsAbsent(
  v.strictObject({
    country: countrySchema,
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
    country: countrySchema,
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
      v.description("Section number without §, e.g. 1729 or 5a."),
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
  consumesServices: true,
  access: "read",
  readClass: "public",
  anonymized: { exposure: "passthrough" },
  feature: "FEATURE_PUBLIC_LAW",
  scope: LAW_READ_SCOPE,
  inputNormalization: {
    country: countryNormalization({ spelling: "alpha-3" }),
  },
} as const;

const LEGAL_RESOLVE_TOOL_DEFINITIONS = [
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
      "Resolve one exact docket (including its sheet) or ECLI; use search_case_law for a case description. Returns the legal resolve API envelope: resolved carries a decision, readerUrl and readable, licence-withheld or unavailable text; ambiguous lists candidates without choosing; incomplete_identifier lists missing parts; not_found names the reason; country_unavailable means no resolver. Open a resolved or explicitly chosen candidate through readerUrl. Supply missing parts and retry for incomplete_identifier. For not_found call search_case_law; for country_unavailable call case_law_coverage. If a recovery scope is absent, add stella:search for search or stella:read for coverage through OAuth consent before that call.",
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
      "Resolve one statute provision from a citation or structured gazette identity and section. Supports Czech statutes; other countries return country_unavailable. Omit as_of for the current expression. Returns the legal resolve API envelope: resolved carries a provision, readerUrl, force dates, versionStatus and blocks; not_found names unknown_document or unknown_section; incomplete_identifier lists missing parts; ambiguous lists candidates without choosing. Open through readerUrl; supply missing parts and retry. For unknown_document use search_legislation; for unknown_section search then read_statute_provisions. Add missing stella:search (search) or stella:read (read) through OAuth consent before recovery calls.",
    inputSchema: resolveLawArgsSchema,
    inputNormalization: {
      ...common.inputNormalization,
      as_of: { kind: AGENT_INPUT_NORMALIZATION_KIND.date, bound: "start" },
    },
  }),
] as const;

type ResolveData = v.InferOutput<typeof legalResolveResponseSchema>;
const handleResolveDecision: TypedMcpToolHandler<ResolveData> = async ({
  args,
  context,
}) => {
  const parsed = v.safeParse(resolveDecisionArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const admission = await (
    context.testDependencies?.admitLawRead ?? defaultAdmitLawRead
  )({ organizationId: context.organizationId });
  if (Result.isError(admission)) {
    return structuredErrorResult(ADMISSION_ERRORS[admission.error.type]);
  }
  const { country, identifier } = parsed.output;
  return toolDataResult(
    await (context.testDependencies?.resolveDecision ?? defaultResolveDecision)(
      { admission: admission.value, country, identifier },
    ),
  );
};
const handleResolveLaw: TypedMcpToolHandler<ResolveData> = async ({
  args,
  context,
}) => {
  const parsed = v.safeParse(resolveLawArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const admission = await (
    context.testDependencies?.admitLawRead ?? defaultAdmitLawRead
  )({ organizationId: context.organizationId });
  if (Result.isError(admission)) {
    return structuredErrorResult(ADMISSION_ERRORS[admission.error.type]);
  }
  const { country, source, section, as_of: asOf } = parsed.output;
  switch (source.type) {
    case "citation":
      return toolDataResult(
        await (
          context.testDependencies?.resolveLawCitation ??
          defaultResolveLawCitation
        )({
          admission: admission.value,
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
          admission: admission.value,
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
export const LEGAL_RESOLVE_TOOL_SET = defineMcpToolSet(
  LEGAL_RESOLVE_TOOL_DEFINITIONS,
  LEGAL_RESOLVE_TOOL_HANDLERS,
  {
    resolve_case_law_decision: defineMcpToolOutput(legalResolveResponseSchema),
    resolve_law_citation: defineMcpToolOutput(legalResolveResponseSchema),
  },
);

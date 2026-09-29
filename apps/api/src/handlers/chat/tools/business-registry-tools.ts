import { toolDefinition } from "@tanstack/ai";
import * as v from "valibot";

import {
  BUSINESS_REGISTRY_LOOKUP_DETAILS,
  type BusinessRegistrySlug,
} from "@stll/api-contract";

import { toTanStackToolSchema } from "@/api/handlers/chat/tools/tanstack-tool-schema";
import {
  executeRegistryLookup,
  type RegistryHandler,
  LOOKUP_DETAIL_DESCRIPTION,
  type RegistryJurisdictionCode,
} from "@/api/lib/business-registries/dispatch";

const BUSINESS_REGISTRY_LOOKUP_TOOL_NAME = "business_registry_lookup" as const;

const TOOL_DESCRIPTION_BASE =
  "Look up companies in official national business registries. " +
  "Use jurisdiction for the country whose registry should be searched, " +
  "for example CZ for the Czech ARES register or NO for " +
  "Brønnøysundregistrene in Norway, or MX for Mexico's INEGI " +
  "DENUE establishment directory. Pass EU to validate an EU VAT " +
  "number against VIES (the VAT Information Exchange System); the " +
  "query must then be a fully-qualified VAT number including the " +
  "2-letter country prefix, e.g. DE143593636. Search by company " +
  "registration number or company name where the selected registry " +
  "supports name search.";

const QUERY_DESCRIPTION_BASE =
  "Company registration number (e.g. Czech IČO, Norwegian orgnr, " +
  "Mexican DENUE establishment Id, fully-qualified EU VAT such as " +
  "DE143593636) or company name. " +
  "Numeric inputs that match the registry's canonical ID format " +
  "route to a direct lookup; everything else is treated as a " +
  "name search where the selected registry supports name search.";

type CreateBusinessRegistryToolsArgs = {
  /**
   * Organization-bound registry handlers permitted on this chat turn.
   * Discovery and execution consume these exact handlers.
   *
   * Accepts the special "EU" pseudo-jurisdiction for EU-wide adapters
   * such as VIES; see `RegistryJurisdictionCode`.
   *
   * Empty array → the tool is not registered (do not surface a
   * jurisdiction picker the model cannot use).
   */
  enabledHandlers: readonly RegistryHandler[];
};

/**
 * Register the unified `business_registry_lookup` chat tool.
 *
 * The `jurisdiction` enum is built from `enabledJurisdictions` so the
 * model can only ask for registries the org is actually allowed to
 * use on this turn. The tool itself is omitted entirely when nothing
 * is enabled so the model does not see a dead picker.
 */
export const createBusinessRegistryTools = ({
  enabledHandlers,
}: CreateBusinessRegistryToolsArgs) => {
  const enabledJurisdictions = [
    ...new Set(enabledHandlers.map(({ country }) => country)),
  ];
  if (enabledJurisdictions.length === 0) {
    return {};
  }

  // valibot's `picklist` requires a tuple of literals. We can safely
  // narrow `enabledJurisdictions` (a runtime array of
  // RegistryJurisdictionCode) to a non-empty readonly tuple here
  // because we just checked length.
  const [first, ...rest] = enabledJurisdictions;
  if (first === undefined) {
    return {};
  }
  const picklistOptions: [
    RegistryJurisdictionCode,
    ...RegistryJurisdictionCode[],
  ] = [first, ...rest];
  const canonicalOnlyJurisdictions = enabledHandlers
    .filter(({ search }) => search === null)
    .map(({ country }) => country);
  const canonicalOnlyGuidance = canonicalOnlyJurisdictions
    .map(canonicalOnlyQueryGuidanceFor)
    .join("; ");
  const canonicalOnlySuffix =
    canonicalOnlyGuidance.length > 0
      ? ` Name search is not supported for these enabled registries: ${canonicalOnlyGuidance}. Ask the user for the canonical identifier instead of passing a company name.`
      : "";

  const [firstHandler, ...otherHandlers] = enabledHandlers;
  if (firstHandler === undefined) {
    return {};
  }
  const registryOptions: [BusinessRegistrySlug, ...BusinessRegistrySlug[]] = [
    firstHandler.slug,
    ...otherHandlers.map(({ slug }) => slug),
  ];

  const inputSchema = v.strictObject({
    jurisdiction: v.pipe(
      v.picklist(picklistOptions),
      v.description(
        "ISO 3166-1 alpha-2 country code for the registry to query, or " +
          "the special 'EU' code for the EU-wide VIES VAT-validation " +
          "service.",
      ),
    ),
    query: v.pipe(
      v.string(),
      v.description(QUERY_DESCRIPTION_BASE + canonicalOnlySuffix),
    ),
    registry: v.optional(
      v.pipe(
        v.picklist(registryOptions),
        v.description(registryDescription(enabledHandlers)),
      ),
    ),
    detail: v.optional(
      v.pipe(
        v.picklist(BUSINESS_REGISTRY_LOOKUP_DETAILS),
        v.description(LOOKUP_DETAIL_DESCRIPTION),
      ),
    ),
    limit: v.optional(
      v.pipe(
        v.number(),
        v.integer(),
        v.minValue(1),
        v.maxValue(50),
        v.description("Maximum number of search results to return."),
      ),
    ),
  });

  return {
    [BUSINESS_REGISTRY_LOOKUP_TOOL_NAME]: toolDefinition({
      name: BUSINESS_REGISTRY_LOOKUP_TOOL_NAME,
      description: TOOL_DESCRIPTION_BASE + canonicalOnlySuffix,
      inputSchema: toTanStackToolSchema(inputSchema),
    }).server(async ({ detail, jurisdiction, limit, query, registry }) => {
      const handler = resolveHandler({
        enabledHandlers,
        jurisdiction,
        registry,
      });
      if (!handler) {
        return {
          error:
            registry === undefined
              ? `No business registry adapter is shipped for jurisdiction ${jurisdiction}`
              : `Registry '${registry}' does not cover jurisdiction ${jurisdiction}`,
        };
      }
      const result = await executeRegistryLookup({
        handler,
        query,
        detail,
        ...(limit === undefined ? {} : { limit }),
      });
      // executeRegistryLookup returns a HandlerError instance for
      // validation / upstream failures; surface those to the model
      // as structured strings rather than throwing — the model can
      // explain the failure to the user instead of the call
      // crashing the chat turn.
      if (result instanceof Error) {
        return { error: result.message };
      }
      return result;
    }),
  };
};

type ResolveHandlerOptions = {
  enabledHandlers: readonly RegistryHandler[];
  jurisdiction: RegistryJurisdictionCode;
  registry: BusinessRegistrySlug | undefined;
};

/**
 * A named register must cover the jurisdiction; otherwise the jurisdiction's
 * primary register answers, or its only enabled one when the primary is off.
 */
const resolveHandler = ({
  enabledHandlers,
  jurisdiction,
  registry,
}: ResolveHandlerOptions): RegistryHandler | undefined => {
  const candidates = enabledHandlers.filter(
    ({ country }) => country === jurisdiction,
  );
  if (registry !== undefined) {
    return candidates.find(({ slug }) => slug === registry);
  }
  const [sole, ...others] = candidates;
  return (
    candidates.find(
      ({ jurisdictionRole }) => jurisdictionRole.type === "primary",
    ) ?? (others.length === 0 ? sole : undefined)
  );
};

/**
 * Describe the optional `registry` input: omitted, the jurisdiction's default
 * register answers; each enabled supplementary register says what it adds.
 */
const registryDescription = (
  enabledHandlers: readonly RegistryHandler[],
): string => {
  const supplementary = enabledHandlers.flatMap(
    ({ country, jurisdictionRole, slug }) =>
      jurisdictionRole.type === "supplementary"
        ? [`${slug} (${country}) covers ${jurisdictionRole.coverage}`]
        : [],
  );
  const base =
    "Register to query within the jurisdiction. Omit to use the " +
    "jurisdiction's default register.";
  return supplementary.length > 0
    ? `${base} ${supplementary.join("; ")}.`
    : base;
};

const canonicalOnlyQueryGuidanceFor = (
  jurisdiction: RegistryJurisdictionCode,
): string => {
  if (jurisdiction === "EU") {
    return "EU/VIES requires a fully-qualified VAT number with the 2-letter country prefix";
  }
  if (jurisdiction === "PL") {
    return "PL/KRS requires the KRS number";
  }
  if (jurisdiction === "US") {
    return "US/EDGAR requires the SEC CIK";
  }
  return `${jurisdiction} requires its registry canonical identifier`;
};

export { BUSINESS_REGISTRY_LOOKUP_TOOL_NAME };

import { valibotSchema } from "@ai-sdk/valibot";
import { tool } from "ai";
import * as v from "valibot";

import {
  executeRegistryLookup,
  getRegistryHandlerDefinitionByCountry,
  getRegistryHandlerByCountry,
  type RegistryJurisdictionCode,
} from "@/api/lib/business-registries/dispatch";

const BUSINESS_REGISTRY_LOOKUP_TOOL_NAME = "business_registry_lookup" as const;

const TOOL_DESCRIPTION_BASE =
  "Look up companies in official national business registries. " +
  "Use jurisdiction for the country whose registry should be searched, " +
  "for example CZ for the Czech ARES register or NO for " +
  "Brønnøysundregistrene in Norway. Pass EU to validate an EU VAT " +
  "number against VIES (the VAT Information Exchange System); the " +
  "query must then be a fully-qualified VAT number including the " +
  "2-letter country prefix, e.g. DE143593636. Search by company " +
  "registration number or company name where the selected registry " +
  "supports name search.";

const QUERY_DESCRIPTION_BASE =
  "Company registration number (e.g. Czech IČO, Norwegian orgnr, " +
  "fully-qualified EU VAT such as DE143593636) or company name. " +
  "Numeric inputs that match the registry's canonical ID format " +
  "route to a direct lookup; everything else is treated as a " +
  "name search where the selected registry supports name search.";

type CreateBusinessRegistryToolsArgs = {
  /**
   * Jurisdiction codes for the registry adapters the org is permitted
   * to call on this chat turn. Computed by the caller from the
   * existing native-tool enablement logic (practice-jurisdiction
   * defaults + `nativeToolOverrides`). Pass only jurisdictions we
   * actually ship an adapter for.
   *
   * Accepts the special "EU" pseudo-jurisdiction for EU-wide adapters
   * such as VIES; see `RegistryJurisdictionCode`.
   *
   * Empty array → the tool is not registered (do not surface a
   * jurisdiction picker the model cannot use).
   */
  enabledJurisdictions: readonly RegistryJurisdictionCode[];
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
  enabledJurisdictions,
}: CreateBusinessRegistryToolsArgs) => {
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
  const picklistOptions = [first, ...rest] as [
    RegistryJurisdictionCode,
    ...RegistryJurisdictionCode[],
  ];
  const canonicalOnlyJurisdictions = enabledJurisdictions.filter(
    (jurisdiction) =>
      getRegistryHandlerDefinitionByCountry(jurisdiction)?.search === null,
  );
  const canonicalOnlyGuidance = canonicalOnlyJurisdictions
    .map(canonicalOnlyQueryGuidanceFor)
    .join("; ");
  const canonicalOnlySuffix =
    canonicalOnlyGuidance.length > 0
      ? ` Name search is not supported for these enabled registries: ${canonicalOnlyGuidance}. Ask the user for the canonical identifier instead of passing a company name.`
      : "";

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
    [BUSINESS_REGISTRY_LOOKUP_TOOL_NAME]: tool({
      description: TOOL_DESCRIPTION_BASE + canonicalOnlySuffix,
      inputSchema: valibotSchema(inputSchema),
      execute: async ({ jurisdiction, limit, query }) => {
        const handler = getRegistryHandlerByCountry(jurisdiction);
        if (!handler) {
          // `enabledJurisdictions` should always be a subset of the
          // countries we ship adapters for, but defend against
          // configuration drift rather than crash mid-tool-call.
          return {
            error: `No business registry adapter is shipped for jurisdiction ${jurisdiction}`,
          };
        }
        const result = await executeRegistryLookup({
          handler,
          query,
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
      },
    }),
  };
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

import { valibotSchema } from "@ai-sdk/valibot";
import { tool } from "ai";
import * as v from "valibot";

import type { CountryCode } from "@stll/country-codes";

import {
  executeRegistryLookup,
  getRegistryHandlerByCountry,
} from "@/api/lib/business-registries/dispatch";

const BUSINESS_REGISTRY_LOOKUP_TOOL_NAME = "business_registry_lookup" as const;

// Static description for the model. The dynamic part — which
// jurisdictions are actually allowed — lives in the input schema.
const TOOL_DESCRIPTION =
  "Look up companies in official national business registries. " +
  "Use jurisdiction for the country whose registry should be searched, " +
  "for example CZ for the Czech ARES register or NO for " +
  "Brønnøysundregistrene in Norway. Search by company registration " +
  "number or company name.";

type CreateBusinessRegistryToolsArgs = {
  /**
   * Country codes for the registry adapters the org is permitted to
   * call on this chat turn. Computed by the caller from the existing
   * native-tool enablement logic (practice-jurisdiction defaults +
   * `nativeToolOverrides`). Pass only countries we actually ship an
   * adapter for.
   *
   * Empty array → the tool is not registered (do not surface a
   * jurisdiction picker the model cannot use).
   */
  enabledJurisdictions: readonly CountryCode[];
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
  // narrow `enabledJurisdictions` (a runtime array of CountryCode) to
  // a non-empty readonly tuple here because we just checked length.
  const [first, ...rest] = enabledJurisdictions;
  if (first === undefined) {
    return {};
  }
  const picklistOptions = [first, ...rest] as [CountryCode, ...CountryCode[]];

  const inputSchema = v.strictObject({
    jurisdiction: v.pipe(
      v.picklist(picklistOptions),
      v.description(
        "ISO 3166-1 alpha-2 country code for the registry to query.",
      ),
    ),
    query: v.pipe(
      v.string(),
      v.description(
        "Company registration number (e.g. Czech IČO, Norwegian orgnr) " +
          "or company name. Numeric inputs that match the registry's " +
          "canonical ID format route to a direct lookup; everything " +
          "else is treated as a name search.",
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
    [BUSINESS_REGISTRY_LOOKUP_TOOL_NAME]: tool({
      description: TOOL_DESCRIPTION,
      inputSchema: valibotSchema(inputSchema),
      execute: async ({ jurisdiction, query }) => {
        const handler = getRegistryHandlerByCountry(jurisdiction);
        if (!handler) {
          // `enabledJurisdictions` should always be a subset of the
          // countries we ship adapters for, but defend against
          // configuration drift rather than crash mid-tool-call.
          return {
            error: `No business registry adapter is shipped for jurisdiction ${jurisdiction}`,
          };
        }
        const result = await executeRegistryLookup({ handler, query });
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

export { BUSINESS_REGISTRY_LOOKUP_TOOL_NAME };

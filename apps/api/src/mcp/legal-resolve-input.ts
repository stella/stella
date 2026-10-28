import * as v from "valibot";

import type { AgentInputNormalizationAnnotation } from "@stll/agent-input";
import { apiDateSchema } from "@stll/api-contract/api-date";

import { LIMITS } from "@/api/lib/limits";

import {
  countryInputSchema,
  countryNormalization,
  nullAsAbsent,
} from "./input-schemas";

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
export const resolveDecisionArgsSchema = nullAsAbsent(
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
export const resolveLawArgsSchema = nullAsAbsent(
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
        apiDateSchema,
        v.description(
          "Expression date YYYY-MM-DD; omit for the current expression.",
        ),
      ),
    ),
  }),
);

/** The resolver reads a country itself, so an unrecognized one reaches it. */
export const LEGAL_RESOLVE_INPUT_NORMALIZATION = {
  country: {
    ...countryNormalization({ spelling: "alpha-3" }),
    invalidValueDisposition: "handler-owned",
  },
} as const satisfies Readonly<
  Record<string, AgentInputNormalizationAnnotation>
>;

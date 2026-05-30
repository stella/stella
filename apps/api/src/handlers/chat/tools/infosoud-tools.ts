import { valibotSchema } from "@ai-sdk/valibot";
import { tool } from "ai";
import * as v from "valibot";

import { createInfoSoudClient } from "@/api/handlers/workspaces/infosoud-common";
import { mapInfoSoudResult } from "@/api/handlers/workspaces/infosoud-result";

export const createInfosoudTools = () => ({
  infosoud_lookup_case: tool({
    description:
      "Look up a Czech court case in InfoSoud by court code and spisová značka. Returns the case identifier, current status, parties (if disclosed), recorded case events, and upcoming hearings.",
    inputSchema: valibotSchema(
      v.strictObject({
        courtCode: v.pipe(
          v.string(),
          v.description(
            "Czech court code (e.g. 'NS' for Nejvyšší soud, 'KSPH' for Krajský soud v Praze).",
          ),
        ),
        spisZn: v.pipe(
          v.string(),
          v.description(
            "Spisová značka in canonical form, e.g. '30 Cdo 161/2024' or '8 Tdo 123/2025'.",
          ),
        ),
      }),
    ),
    execute: async ({ courtCode, spisZn }) => {
      const client = createInfoSoudClient();
      const lookupResult = await client.searchCaseWithHearings({
        courtCode,
        spisZn,
      });
      // Reuse the bounded mapper from the REST handler so chat output
      // respects the same event/hearing/related-case caps and never
      // blows up the model context on long-running cases.
      return mapInfoSoudResult({
        lookupResult,
        selectedCourtCode: courtCode,
      });
    },
  }),
});

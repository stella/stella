import { Result } from "better-result";

import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

import {
  createInfoSoudClient,
  infosoudLookupBodySchema,
  toInfoSoudLookupError,
} from "./infosoud-common";
import { mapInfoSoudResult } from "./infosoud-result";

const config = {
  body: infosoudLookupBodySchema,
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

const infosoudLookup = createSafeHandler(
  config,
  async function* ({ body, request }) {
    const result = yield* Result.await(
      Result.tryPromise({
        try: async () => {
          const client = createInfoSoudClient();
          const lookupResult = await client.searchCaseWithHearings({
            courtCode: body.courtCode,
            signal: request.signal,
            spisZn: body.spisZn,
          });

          return mapInfoSoudResult({
            lookupResult,
            selectedCourtCode: body.courtCode,
          });
        },
        catch: toInfoSoudLookupError,
      }),
    );

    return Result.ok(result);
  },
);

export default infosoudLookup;

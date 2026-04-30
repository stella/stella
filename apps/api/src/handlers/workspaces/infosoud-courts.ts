import {
  buildCourtMapFromEntries,
  InfoSoudAPIError,
  InfoSoudClient,
  InfoSoudParseError,
  InfoSoudRequestError,
} from "@stll/infosoud";
import { Result } from "better-result";

import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const createInfoSoudClient = () => new InfoSoudClient({ cache: false });

const toInfoSoudCourtsError = (error: unknown): HandlerError => {
  if (error instanceof InfoSoudAPIError) {
    return new HandlerError({
      status: 502,
      message: "InfoSoud returned an error while loading courts",
      cause: error,
    });
  }

  if (error instanceof InfoSoudParseError) {
    return new HandlerError({
      status: 502,
      message: "InfoSoud returned an invalid courts response",
      cause: error,
    });
  }

  if (error instanceof InfoSoudRequestError) {
    return new HandlerError({
      status: 502,
      message: "InfoSoud courts request failed",
      cause: error,
    });
  }

  return new HandlerError({
    status: 500,
    message: "InfoSoud courts lookup failed",
    cause: error,
  });
};

const config = {
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

const infosoudCourts = createSafeHandler(config, async function* ({ request }) {
  const signal = request.signal;
  const result = yield* Result.await(
    Result.tryPromise({
      try: async () => {
        const client = createInfoSoudClient();
        const courts = await client.getCourts({ signal });
        const districtCourts = await client.getDistrictCourts({ signal });
        const courtMap = buildCourtMapFromEntries([
          ...courts,
          ...districtCourts,
        ]);

        return Object.entries(courtMap)
          .map(([code, name]) => ({ code, name }))
          .toSorted((left, right) =>
            left.name.localeCompare(right.name, "cs-CZ"),
          );
      },
      catch: toInfoSoudCourtsError,
    }),
  );

  return Result.ok({ courts: result });
});

export default infosoudCourts;

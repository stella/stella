import { Result } from "better-result";

import {
  buildCourtMapFromEntries,
  InfoSoudAPIError,
  InfoSoudParseError,
  InfoSoudRequestError,
} from "@stll/infosoud";

import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { compareByLocale } from "@/api/lib/collation";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

import { getInfoSoudClient } from "./infosoud-common";

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
  mcp: { type: "internal", reason: "native_tool_ui" },
} satisfies HandlerConfig;

const infosoudCourts = createSafeHandler(config, async function* ({ request }) {
  const signal = request.signal;
  const result = yield* Result.await(
    Result.tryPromise({
      try: async () => {
        const client = getInfoSoudClient();
        // Sequential, not Promise.all: the shared client serializes every
        // call through one politeness throttle, so both loads never run
        // concurrently anyway. Promise.all would still enqueue the district
        // load immediately, so a failure on the first load left the second
        // queued and running against InfoSoud after this handler had already
        // returned its error response.
        const courts = await client.getCourts({ signal });
        const districtCourts = await client.getDistrictCourts({ signal });
        const courtMap = buildCourtMapFromEntries([
          ...courts,
          ...districtCourts,
        ]);

        // Court names are always Czech (InfoSoud is the Czech court
        // registry), independent of the viewer's UI locale.
        const compareCourtNames = compareByLocale("cs-CZ");
        return Object.entries(courtMap)
          .map(([code, name]) => ({ code, name }))
          .toSorted((left, right) => compareCourtNames(left.name, right.name));
      },
      catch: toInfoSoudCourtsError,
    }),
  );

  return Result.ok({ courts: result });
});

export default infosoudCourts;

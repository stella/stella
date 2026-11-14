import { expect, test } from "bun:test";

import {
  InfoSoudAPIError,
  InfoSoudParseError,
  InfoSoudRequestError,
} from "@stll/infosoud";

import { toInfoSoudLookupError } from "./infosoud-common";

const apiError = (status: number) =>
  new InfoSoudAPIError({
    message: "Request failed",
    path: "/test",
    responseBody: null,
    status,
  });

test("InfoSoud service failures retain their cause and upstream classification", () => {
  for (const cause of [
    apiError(502),
    apiError(503),
    new InfoSoudRequestError("/test", "Transport failed"),
  ]) {
    const mapped = toInfoSoudLookupError(cause);
    expect(mapped.status).toBe(502);
    expect(mapped.code).toBe("upstream_unavailable");
    expect(mapped.cause).toBe(cause);
  }
});

test("InfoSoud lookup refusals and invalid data retain their meaning", () => {
  const notFound = toInfoSoudLookupError(apiError(400));
  expect(notFound.status).toBe(404);
  expect(notFound.code).toBeUndefined();
  const invalid = toInfoSoudLookupError(
    new InfoSoudParseError("Invalid case reference"),
  );
  expect(invalid.status).toBe(400);
  expect(invalid.code).toBeUndefined();
  expect(toInfoSoudLookupError(apiError(403)).code).toBe("internal_error");
});

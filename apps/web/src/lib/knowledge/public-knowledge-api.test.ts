import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { APIError } from "@/lib/errors/api";
import { unwrapPublicKnowledge } from "@/lib/knowledge/public-knowledge-api";

/** What a read raises, if anything. */
const raised = (read: () => unknown): unknown => {
  const outcome = Result.try({ try: read, catch: (error) => error });
  return Result.isError(outcome) ? outcome.error : undefined;
};

describe("unwrapPublicKnowledge", () => {
  test("a read passes its data through", () => {
    expect(
      unwrapPublicKnowledge({ data: { items: [] }, error: null }, "list"),
    ).toEqual({ items: [] });
  });

  test("a missing item is an answer, not a failure", () => {
    expect(
      unwrapPublicKnowledge(
        { data: null, error: { status: 404, value: { message: "missing" } } },
        "read",
      ),
    ).toBeNull();
  });

  test("the catalogue being off is raised, however it is answered", () => {
    const offAsError = raised(() =>
      unwrapPublicKnowledge(
        { data: null, error: { status: 404, value: { error: "Not Found" } } },
        "list",
      ),
    );
    const offAsData = raised(() =>
      unwrapPublicKnowledge(
        { data: { error: "Not Found" }, error: null },
        "list",
      ),
    );
    for (const error of [offAsError, offAsData]) {
      expect(APIError.is(error)).toBe(true);
      expect(APIError.is(error) && error.status).toBe(503);
    }
  });

  test("any other failure is raised with its status", () => {
    const error = raised(() =>
      unwrapPublicKnowledge(
        { data: null, error: { status: 500, value: { message: "boom" } } },
        "list",
      ),
    );
    expect(APIError.is(error) && error.status).toBe(500);
  });
});

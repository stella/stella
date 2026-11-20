import { describe, expect, test } from "bun:test";

import { stellaAppDisclosure } from "@/components/chat/stella-app-disclosure.logic";

const call = (
  input: Record<string, unknown>,
  structuredContent: Record<string, unknown>,
) => ({ input, result: { structuredContent } });

describe("stellaAppDisclosure", () => {
  test("opens every app other than the case-law result list", () => {
    expect(
      stellaAppDisclosure("decision-reader", call({ queries: ["x"] }, {})),
    ).toEqual({ type: "open" });
    expect(stellaAppDisclosure(null, call({}, {}))).toEqual({ type: "open" });
  });

  test("summarises a search by its phrasings and its result count", () => {
    expect(
      stellaAppDisclosure(
        "case-law-results",
        call(
          { queries: [" lhůta ", "", 7, "dovolání"] },
          { results: [{}, {}] },
        ),
      ),
    ).toEqual({
      type: "case-law",
      query: "lhůta · dovolání",
      decisionCount: 2,
    });
  });

  test("reads a single query and leaves an unknown count out", () => {
    expect(
      stellaAppDisclosure(
        "case-law-results",
        call({ query: "výpověď" }, { status: "resolved" }),
      ),
    ).toEqual({ type: "case-law", query: "výpověď", decisionCount: null });
  });
});

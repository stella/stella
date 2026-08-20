import { describe, expect, test } from "bun:test";

import {
  decodeDecisionCitationCursor,
  encodeDecisionCitationCursor,
} from "@/api/handlers/case-law/decisions/get";
import { encodePaginationCursor } from "@/api/lib/pagination";

describe("decision citation cursor", () => {
  test("preserves an exhausted stream while the other stream continues", () => {
    const cursor = encodeDecisionCitationCursor({
      from: { status: "exhausted" },
      to: { after: "incoming-next", status: "continue" },
    });

    expect(cursor).not.toBeNull();
    expect(decodeDecisionCitationCursor(cursor)).toEqual({
      from: { status: "exhausted" },
      to: { after: "incoming-next", status: "continue" },
    });
  });

  test("ends only after both streams are exhausted", () => {
    expect(
      encodeDecisionCitationCursor({
        from: { status: "exhausted" },
        to: { status: "exhausted" },
      }),
    ).toBeNull();
  });

  test("rejects malformed compound state", () => {
    expect(decodeDecisionCitationCursor("not-a-cursor")).toBeNull();
    expect(
      decodeDecisionCitationCursor(encodePaginationCursor(["only-one"])),
    ).toBeNull();
    expect(
      decodeDecisionCitationCursor(
        encodePaginationCursor(["from", "to", "extra"]),
      ),
    ).toBeNull();
    expect(
      decodeDecisionCitationCursor(encodePaginationCursor([1, 2])),
    ).toBeNull();
  });

  test("seeds both streams when no cursor is supplied", () => {
    expect(decodeDecisionCitationCursor(undefined)).toEqual({
      from: { status: "start" },
      to: { status: "start" },
    });
  });
});

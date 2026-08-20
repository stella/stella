import { describe, expect, test } from "bun:test";

import {
  decodeDecisionCitationCursor,
  encodeDecisionCitationCursor,
} from "@/api/handlers/case-law/decisions/get";

describe("decision citation cursor", () => {
  test("preserves an exhausted stream while the other stream continues", () => {
    const cursor = encodeDecisionCitationCursor({
      from: null,
      to: "incoming-next",
    });

    expect(cursor).not.toBeNull();
    expect(decodeDecisionCitationCursor(cursor)).toEqual({
      from: null,
      to: "incoming-next",
    });
  });

  test("ends only after both streams are exhausted", () => {
    expect(encodeDecisionCitationCursor({ from: null, to: null })).toBeNull();
  });

  test("rejects malformed compound state", () => {
    expect(decodeDecisionCitationCursor("not-a-cursor")).toBeNull();
  });
});

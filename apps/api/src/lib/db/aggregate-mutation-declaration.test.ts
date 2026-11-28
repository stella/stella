import { describe, expect, test } from "bun:test";

import { routes } from "@/api/http/route";
import { defineEndpoint } from "@/api/lib/endpoints";

import { collectUndeclaredAggregateMutations } from "./aggregate-mutation-declaration";

describe("aggregate mutation ownership", () => {
  test("reads ownership declarations directly from mounted route configs", () => {
    const declared = defineEndpoint.public(
      {
        aggregateMutation: {
          type: "independent",
          reason: "Responds without persistent mutation.",
        },
      },
      () => "ok",
    );
    const entries = routes({
      "/declared": { POST: declared },
      "/read": { GET: defineEndpoint.public({}, () => "read") },
      "/planted": { DELETE: defineEndpoint.public({}, () => "undeclared") },
    });
    expect(collectUndeclaredAggregateMutations(entries)).toEqual([
      "DELETE /planted",
    ]);
  });

  test("rejects blank reasons on independent mutation declarations", () => {
    expect(() =>
      defineEndpoint.public(
        {
          aggregateMutation: { type: "independent", reason: " " },
        },
        () => "ok",
      ),
    ).toThrow("requires a reason");
  });
});

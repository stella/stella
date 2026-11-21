import { describe, expect, test } from "bun:test";

import { routes } from "@/api/http/route";
import { defineEndpoint } from "@/api/lib/endpoints";

import {
  collectUndeclaredAggregateMutations,
  declareAggregateMutation,
} from "./aggregate-mutation-declaration";

describe("aggregate mutation ownership", () => {
  test("enumerates mounted route definitions without changing their identity", () => {
    const definition = defineEndpoint.public({}, () => "ok");
    const declared = declareAggregateMutation(definition, {
      type: "independent",
      reason: "Responds without persistent mutation.",
    });
    expect(declared).toBe(definition);
    const entries = routes({
      "/declared": { POST: declared },
      "/read": { GET: defineEndpoint.public({}, () => "read") },
      "/planted": { DELETE: defineEndpoint.public({}, () => "undeclared") },
    });
    expect(collectUndeclaredAggregateMutations(entries)).toEqual([
      "DELETE /planted",
    ]);
  });

  test("rejects missing reasons and repeated ownership", () => {
    expect(() =>
      declareAggregateMutation(
        defineEndpoint.public({}, () => "ok"),
        { type: "independent", reason: " " },
      ),
    ).toThrow("requires a reason");
    const definition = defineEndpoint.public({}, () => "ok");
    declareAggregateMutation(definition, {
      type: "independent",
      reason: "No persistence.",
    });
    expect(() =>
      declareAggregateMutation(definition, {
        type: "independent",
        reason: "Other ownership.",
      }),
    ).toThrow("already declared");
  });
});

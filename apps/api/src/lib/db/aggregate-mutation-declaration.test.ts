import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import {
  collectUndeclaredAggregateMutations,
  declareAggregateMutation,
} from "./aggregate-mutation-declaration";

describe("aggregate mutation ownership", () => {
  test("enumerates actual Elysia handlers without changing their identity", () => {
    const handler = () => "ok";
    const declared = declareAggregateMutation(handler, {
      type: "independent",
      reason: "Responds without persistent mutation.",
    });
    expect(declared).toBe(handler);
    const api = new Elysia()
      .post("/declared", declared)
      .get("/read", () => "read")
      .delete("/planted", () => "undeclared")
      .all("/transport", () => "transport");
    expect(collectUndeclaredAggregateMutations(api.routes)).toEqual([
      "DELETE /planted",
      "ALL /transport",
    ]);
  });

  test("rejects missing reasons and repeated ownership", () => {
    expect(() =>
      declareAggregateMutation(() => "ok", {
        type: "independent",
        reason: " ",
      }),
    ).toThrow("requires a reason");
    const handler = () => "ok";
    declareAggregateMutation(handler, {
      type: "independent",
      reason: "No persistence.",
    });
    expect(() =>
      declareAggregateMutation(handler, {
        type: "independent",
        reason: "Other ownership.",
      }),
    ).toThrow("already declared");
  });
});

import { describe, expect, test } from "bun:test";
import { t } from "elysia";

import {
  assertWriteContract,
  getWriteContract,
  recordWriteContract,
} from "./write-contract";

const timestampContract = {
  contract: "replace",
  precondition: { type: "updatedAt", field: "expectedUpdatedAt" },
} as const;

describe("replacement precondition schemas", () => {
  test("a planted replacement without a required precondition fails at the factory boundary", () => {
    for (const body of [
      t.Object({ values: t.Array(t.String()) }),
      t.Any({ required: ["expectedUpdatedAt"] }),
      t.Object({ expectedUpdatedAt: t.Any() }),
      t.Object({ expectedUpdatedAt: t.Number() }),
      t.Object({ expectedUpdatedAt: t.Optional(t.String()) }),
      t.Union([
        t.Object({ expectedUpdatedAt: t.String({ format: "date-time" }) }),
        t.Object({ values: t.Array(t.String()) }),
      ]),
    ]) {
      expect(() => assertWriteContract({ ...timestampContract, body })).toThrow(
        "must require expectedUpdatedAt in every branch",
      );
    }
  });

  test("required tokens survive every union alternative and intersection", () => {
    const token = t.Object({
      expectedUpdatedAt: t.String({ format: "date-time" }),
    });
    const bodies = [
      token,
      t.Union([
        t.Object({
          type: t.Literal("a"),
          expectedUpdatedAt: t.String({ format: "date-time" }),
        }),
        t.Object({
          type: t.Literal("b"),
          expectedUpdatedAt: t.String({ format: "date-time" }),
        }),
      ]),
      t.Intersect([token, t.Object({ values: t.Array(t.String()) })]),
    ];
    for (const body of bodies) {
      const handler = () => undefined;
      const config = { ...timestampContract, body };
      recordWriteContract(handler, config);
      expect(getWriteContract(handler)).toBe(config);
    }
  });

  test("compound revision protocols require every field", () => {
    expect(() =>
      assertWriteContract({
        contract: "replace",
        precondition: {
          type: "revision",
          fields: ["expectedGeneration", "expectedSnapshotRevision"],
        },
        body: t.Object({ expectedGeneration: t.Integer() }),
      }),
    ).toThrow("must require expectedSnapshotRevision in every branch");
  });

  test("a Replace description cannot declare patch", () => {
    expect(() =>
      assertWriteContract({ contract: "patch", description: "Replace tags" }),
    ).toThrow("A Replace description requires contract: replace");
  });
});

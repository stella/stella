import { describe, expect, test } from "bun:test";
import { t } from "elysia";

import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { VERSION_CONFLICT_ERROR_CODE } from "@/api/lib/optimistic-concurrency";

import {
  assertWriteContract,
  enforceWritePrecondition,
  getWriteContract,
  recordWriteContract,
} from "./write-contract";

const timestampContract = {
  contract: "replace",
  precondition: { type: "updatedAt", field: "expectedUpdatedAt" },
} as const;

describe("replacement writes require the state the caller read", () => {
  test("stale and malformed timestamp tokens stop the replacement before any write", () => {
    for (const expectedUpdatedAt of [
      "2026-01-01T00:00:00.000Z",
      "invalid-timestamp",
    ]) {
      const row = {
        updatedAt: new Date("2026-01-02T00:00:00.000Z"),
        values: ["original"],
      };
      const replace = () => {
        const conflict = enforceWritePrecondition({
          type: "updatedAt",
          field: "expectedUpdatedAt",
          storedUpdatedAt: row.updatedAt,
          expectedUpdatedAt,
          resource: "Record",
        });
        if (conflict !== null) {
          return conflict;
        }
        row.values = ["replacement"];
        return null;
      };
      const conflict = replace();
      expect(conflict).toBeInstanceOf(HandlerError);
      expect(conflict).toMatchObject({
        status: 409,
        code: VERSION_CONFLICT_ERROR_CODE,
      });
      expect(row.values).toEqual(["original"]);
    }
  });

  test("timestamps describing the same instant allow the replacement", () => {
    const row = {
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      values: ["original"],
    };
    const replace = () => {
      const conflict = enforceWritePrecondition({
        type: "updatedAt",
        field: "expectedUpdatedAt",
        storedUpdatedAt: row.updatedAt,
        expectedUpdatedAt: "2026-01-02T01:00:00.000+01:00",
        resource: "Record",
      });
      if (conflict !== null) {
        return conflict;
      }
      row.values = ["replacement"];
      return null;
    };
    expect(replace()).toBeNull();
    expect(row.values).toEqual(["replacement"]);
  });

  test("a differing revision token stops the replacement with the standard conflict", () => {
    for (const tokens of [
      { storedRevision: 2, expectedRevision: 1 },
      { storedRevision: "current", expectedRevision: "previous" },
      { storedRevision: 1, expectedRevision: "1" },
    ]) {
      const row = { values: ["original"] };
      const replace = () => {
        const conflict = enforceWritePrecondition({
          type: "revision",
          field: "revision",
          ...tokens,
          resource: "Record",
        });
        if (conflict !== null) {
          return conflict;
        }
        row.values = ["replacement"];
        return null;
      };
      const conflict = replace();
      expect(conflict).toBeInstanceOf(HandlerError);
      expect(conflict).toMatchObject({
        status: 409,
        code: VERSION_CONFLICT_ERROR_CODE,
      });
      expect(row.values).toEqual(["original"]);
    }
  });

  test("matching numeric and string revisions allow the replacement", () => {
    for (const revision of [2, "current"]) {
      const row = { values: ["original"] };
      const replace = () => {
        const conflict = enforceWritePrecondition({
          type: "revision",
          field: "revision",
          storedRevision: revision,
          expectedRevision: revision,
          resource: "Record",
        });
        if (conflict !== null) {
          return conflict;
        }
        row.values = ["replacement"];
        return null;
      };
      expect(replace()).toBeNull();
      expect(row.values).toEqual(["replacement"]);
    }
  });
});

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

  test("revision protocols accept transformed integer tokens and reject nullable tokens", () => {
    const revision = {
      contract: "replace",
      precondition: {
        type: "revision",
        fields: ["expectedGeneration", "expectedSnapshotRevision"],
      },
    } as const;
    expect(() =>
      assertWriteContract({
        ...revision,
        body: t.Object({
          expectedGeneration: t.Integer({ minimum: 0 }),
          expectedSnapshotRevision: t.Integer({ minimum: 0 }),
        }),
      }),
    ).not.toThrow();
    expect(() =>
      assertWriteContract({
        ...revision,
        body: t.Object({
          expectedGeneration: t.Integer(),
          expectedSnapshotRevision: t.Union([t.Integer(), t.Null()]),
        }),
      }),
    ).toThrow("must require expectedSnapshotRevision in every branch");
  });

  test("a Replace description cannot declare patch", () => {
    expect(() =>
      assertWriteContract({ contract: "patch", description: "Replace tags" }),
    ).toThrow("A Replace description requires contract: replace");
  });
});

test("invalid contract registration names the handler, source and violated rule", () => {
  const invalidReplacement = () => undefined;
  expect(() =>
    recordWriteContract(invalidReplacement, {
      ...timestampContract,
      body: t.Object({ values: t.Array(t.String()) }),
    }),
  ).toThrow(
    /Invalid write contract for invalidReplacement: A replacement body must require expectedUpdatedAt in every branch[\s\S]*Handler registration:[\s\S]*write-contract\.test\.ts/u,
  );
  expect(getWriteContract(invalidReplacement)).toBeUndefined();
});

test("malformed runtime contract declarations report readable registration failures", () => {
  const invalidRegistration = () => undefined;
  const declarations = [
    { config: {}, rule: "Declare contract: patch or contract: replace" },
    {
      config: { contract: "unknown" },
      rule: "Declare contract: patch or contract: replace",
    },
    {
      config: { contract: "replace" },
      rule: "A replacement requires a declared precondition",
    },
    {
      config: { contract: "replace", precondition: { type: "unknown" } },
      rule: "A replacement precondition must be updatedAt, revision, or deferred",
    },
  ];
  for (const { config, rule } of declarations) {
    expect(() =>
      Reflect.apply(recordWriteContract, undefined, [
        invalidRegistration,
        config,
      ]),
    ).toThrow(`Invalid write contract for invalidRegistration: ${rule}`);
  }
  expect(getWriteContract(invalidRegistration)).toBeUndefined();
});

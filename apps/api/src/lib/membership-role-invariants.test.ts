import { PGlite } from "@electric-sql/pglite";
import { APIError } from "better-auth/api";
import { panic, Result } from "better-result";
import { SQL } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DrizzleQueryError } from "drizzle-orm/errors";

import {
  mapMembershipInvariantError,
  OWNER_REQUIRED_CONSTRAINT,
  OWNER_REQUIRED_ERROR_CODE,
} from "@/api/lib/membership-role-invariants";

const constraints = [
  { constraint: OWNER_REQUIRED_CONSTRAINT, code: OWNER_REQUIRED_ERROR_CODE },
  { constraint: "member_single_product_role", code: "invalid_member_role" },
  { constraint: "invitation_single_product_role", code: "invalid_member_role" },
];

let database: PGlite;
const getDatabase = () => database;
beforeAll(async () => {
  database = new PGlite();
});
afterAll(async () => {
  await getDatabase().close();
});

describe("membership constraint refusals", () => {
  for (const { constraint, code } of constraints) {
    test(`${constraint} maps direct and Drizzle-wrapped driver errors to a typed refusal`, async () => {
      const postgres = new SQL.PostgresError("Membership constraint refusal", {
        code: "23514",
        constraint,
      });
      const raised = await Result.tryPromise({
        try: async () =>
          await getDatabase().exec(
            `DO $$ BEGIN RAISE EXCEPTION USING ERRCODE = '23514', CONSTRAINT = '${constraint}', MESSAGE = 'Membership constraint refusal'; END $$;`,
          ),
        catch: (cause) => cause,
      });
      if (Result.isOk(raised)) {
        panic("PGlite did not raise its named check violation");
      }
      const pglite = raised.error;
      if (!(pglite instanceof Error)) {
        panic("PGlite did not return a driver error");
      }
      expect(pglite).toMatchObject({ code: "23514", constraint });
      for (const driverError of [postgres, pglite]) {
        for (const error of [
          driverError,
          new DrizzleQueryError(
            "UPDATE member SET role = $1",
            ["member"],
            driverError,
          ),
        ]) {
          const mapped = mapMembershipInvariantError(error);
          expect(mapped).toBeInstanceOf(APIError);
          if (!(mapped instanceof APIError)) {
            panic("Expected a typed membership refusal");
          }
          expect(mapped.status).toBe("BAD_REQUEST");
          expect(mapped.body).toMatchObject({ code });
        }
      }
    });
  }

  test("nested constraint_name envelopes map without requiring one wrapper depth", () => {
    const error = {
      cause: {
        cause: { code: "23514", constraint_name: OWNER_REQUIRED_CONSTRAINT },
      },
    };
    const mapped = mapMembershipInvariantError(error);
    expect(mapped).toBeInstanceOf(APIError);
    if (!(mapped instanceof APIError)) {
      panic("Expected a typed membership refusal");
    }
    expect(mapped.body).toMatchObject({ code: OWNER_REQUIRED_ERROR_CODE });
  });

  test("unrelated errors and cyclic cause envelopes retain identity", () => {
    const unrelated = new SQL.PostgresError("Other constraint refusal", {
      code: "23514",
      constraint: "other_check_constraint",
    });
    const wrapped = new DrizzleQueryError(
      "UPDATE member SET role = $1",
      ["member"],
      unrelated,
    );
    const cycle: { cause?: unknown } = {};
    const inner = { cause: cycle };
    cycle.cause = inner;
    for (const error of [
      unrelated,
      wrapped,
      cycle,
      undefined,
      null,
      "driver failure",
    ]) {
      expect(mapMembershipInvariantError(error)).toBe(error);
    }
  });

  test("a named constraint before a cyclic cause still maps", () => {
    const cause: { constraint: string; cause?: unknown } = {
      constraint: OWNER_REQUIRED_CONSTRAINT,
    };
    cause.cause = cause;
    const mapped = mapMembershipInvariantError(cause);
    expect(mapped).toBeInstanceOf(APIError);
    if (!(mapped instanceof APIError)) {
      panic("Expected a typed membership refusal");
    }
    expect(mapped.body).toMatchObject({ code: OWNER_REQUIRED_ERROR_CODE });
  });
});

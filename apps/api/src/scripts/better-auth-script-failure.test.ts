import { describe, expect, test } from "bun:test";

import { formatBetterAuthScriptFailure } from "@/api/scripts/better-auth-script-failure";

const parse = (line: string): unknown => JSON.parse(line);

describe("formatBetterAuthScriptFailure", () => {
  test("emits the message alongside the code", () => {
    const line = formatBetterAuthScriptFailure({
      code: "database-query-failed",
      message: "Microsoft identity sources could not be read",
    });
    expect(line.endsWith("\n")).toBe(true);
    expect(parse(line)).toEqual({
      code: "database-query-failed",
      message: "Microsoft identity sources could not be read",
      status: "error",
    });
  });

  test("describes an Error cause with its SQLSTATE", () => {
    const cause = Object.assign(
      new Error("permission denied for table account"),
      { errno: "42501", name: "PostgresError" },
    );
    expect(
      parse(
        formatBetterAuthScriptFailure({
          cause,
          code: "database-query-failed",
          message: "query failed",
        }),
      ),
    ).toMatchObject({
      cause: {
        errno: "42501",
        message: "permission denied for table account",
        name: "PostgresError",
      },
    });
  });

  test("scrubs row values and bounds the cause message", () => {
    const cause = new Error(
      `duplicate key value violates unique constraint "account_pkey" Key (id)=(secret-row) ${"x".repeat(1000)}`,
    );
    expect(
      parse(
        formatBetterAuthScriptFailure({
          cause,
          code: "database-query-failed",
          message: "query failed",
        }),
      ),
    ).toMatchObject({
      cause: {
        message: expect.stringMatching(
          /^(?!.*secret-row)(?=.*Key \(redacted\)).{0,500}$/u,
        ),
      },
    });
  });

  test("describes a non-Error cause by type only", () => {
    expect(
      parse(
        formatBetterAuthScriptFailure({
          cause: "id_token=leak",
          code: "unexpected-failure",
          message: "boom",
        }),
      ),
    ).toMatchObject({ cause: { message: "", name: "string" } });
  });
});

import { describe, expect, test } from "bun:test";

import { formatBetterAuthScriptFailure } from "@/api/scripts/better-auth-script-failure";

const parse = (line: string) => JSON.parse(line) as Record<string, unknown>;

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
      )["cause"],
    ).toEqual({
      errno: "42501",
      message: "permission denied for table account",
      name: "PostgresError",
    });
  });

  test("scrubs row values and bounds the cause message", () => {
    const cause = new Error(
      `duplicate key value violates unique constraint "account_pkey" Key (id)=(secret-row) ${"x".repeat(1000)}`,
    );
    const described = parse(
      formatBetterAuthScriptFailure({
        cause,
        code: "database-query-failed",
        message: "query failed",
      }),
    )["cause"] as { message: string };
    expect(described.message).not.toContain("secret-row");
    expect(described.message).toContain("Key (redacted)");
    expect(described.message.length).toBeLessThanOrEqual(500);
  });

  test("describes a non-Error cause by type only", () => {
    expect(
      parse(
        formatBetterAuthScriptFailure({
          cause: "id_token=leak",
          code: "unexpected-failure",
          message: "boom",
        }),
      )["cause"],
    ).toEqual({ message: "", name: "string" });
  });
});

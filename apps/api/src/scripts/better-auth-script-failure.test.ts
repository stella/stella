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

  test("walks the cause chain and keeps only names, codes, and SQLSTATE", () => {
    const postgres = Object.assign(
      new Error("permission denied for table account"),
      {
        code: "ERR_POSTGRES_SERVER_ERROR",
        errno: "42501",
        name: "PostgresError",
      },
    );
    const wrapper = Object.assign(
      new Error(
        'Failed query: select * from "account" where "id" > $1 params: secret-account-id',
        { cause: postgres },
      ),
      { name: "DrizzleQueryError" },
    );
    const line = formatBetterAuthScriptFailure({
      cause: wrapper,
      code: "database-query-failed",
      message: "query failed",
    });
    expect(line).not.toContain("secret-account-id");
    expect(line).not.toContain("permission denied");
    expect(parse(line)).toMatchObject({
      cause: {
        code: "ERR_POSTGRES_SERVER_ERROR",
        names: ["DrizzleQueryError", "PostgresError"],
        sqlState: "42501",
      },
    });
  });

  test("ignores codes outside the fixed vocabulary", () => {
    const cause = Object.assign(new Error("boom"), { code: "id_token=leak" });
    expect(
      parse(
        formatBetterAuthScriptFailure({
          cause,
          code: "unexpected-failure",
          message: "boom",
        }),
      ),
    ).toEqual({
      cause: { names: ["Error"] },
      code: "unexpected-failure",
      message: "boom",
      status: "error",
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
    ).toMatchObject({ cause: { names: ["string"] } });
  });

  test("bounds the cause-chain walk", () => {
    let cause: Error = new Error("innermost");
    for (let depth = 0; depth < 10; depth += 1) {
      cause = new Error("wrapper", { cause });
    }
    expect(
      parse(
        formatBetterAuthScriptFailure({
          cause,
          code: "unexpected-failure",
          message: "boom",
        }),
      ),
    ).toMatchObject({
      cause: { names: Array.from({ length: 5 }, () => "Error") },
    });
  });
});

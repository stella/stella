import { Result } from "better-result";
import { describe, expect, test } from "bun:test";

import { authorizeLegalResolveRequest } from "@/api/handlers/legal-resolve/authorization";
import { hasLawReadScope } from "@/api/handlers/legal-resolve/scope";

describe("legal resolve scope", () => {
  test("accepts the law scope and its general-read superset", () => {
    expect(hasLawReadScope(["stella:law_read"])).toBe(true);
    expect(hasLawReadScope(["stella:read"])).toBe(true);
  });

  test("rejects unrelated and absent scopes", () => {
    expect(hasLawReadScope([])).toBe(false);
    expect(hasLawReadScope(["stella:search"])).toBe(false);
  });
});

test("legal resolve refuses access while the public-law plan state is off", async () => {
  const result = await authorizeLegalResolveRequest(
    new Request("http://localhost", {
      headers: { authorization: "Bearer token" },
    }),
    {
      authenticate: async () =>
        Result.ok({
          userId: "user",
          organizationId: "organization",
          scopes: ["stella:law_read"],
        }),
      publicLawEnabled: () => false,
    },
  );
  expect(result).toEqual({ status: 403, body: { error: "missing_scope" } });
});

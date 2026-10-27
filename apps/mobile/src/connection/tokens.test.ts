import { expect, test } from "bun:test";

import { refreshTokens } from "./tokens";

test("token validation errors do not retain credential values", async () => {
  const accessToken = "secret-access-value";
  const refreshToken = "secret-refresh-value";
  const result = await refreshTokens({
    clientId: "mobile-client",
    fetch: async () =>
      Response.json({
        access_token: accessToken,
        expires_in: "not-a-number",
        refresh_token: refreshToken,
        token_type: "Bearer",
      }),
    refreshToken,
    resource: "https://stella.example.com/v1",
    tokenEndpoint: "https://stella.example.com/oauth/token",
  });

  expect(result.isErr()).toBeTrue();
  expect(JSON.stringify(result)).not.toContain(accessToken);
  expect(JSON.stringify(result)).not.toContain(refreshToken);
});

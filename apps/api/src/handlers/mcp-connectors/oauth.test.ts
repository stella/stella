import { describe, expect, test } from "bun:test";

import { redactMcpOAuthRegistrationResponse } from "@/api/handlers/mcp-connectors/oauth-registration-response";

describe("redactMcpOAuthRegistrationResponse", () => {
  test("removes client credentials from dynamic registration metadata", () => {
    const redacted = redactMcpOAuthRegistrationResponse({
      client_id: "client-123",
      client_secret: "secret",
      nested: {
        registration_access_token: "token",
        safe_value: "kept",
      },
      token_endpoint_auth_method: "none",
    });

    expect(redacted).toEqual({
      client_id: "client-123",
      client_secret: "[redacted]",
      nested: {
        registration_access_token: "[redacted]",
        safe_value: "kept",
      },
      token_endpoint_auth_method: "none",
    });
  });
});

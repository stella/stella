import { describe, expect, test } from "bun:test";

import { AGENT_AUTH_MANIFEST_PATH } from "@/api/agent-auth/constants";
import { agentAuthRoute } from "@/api/handlers/agent-auth/routes";

describe("agent-auth manifest route", () => {
  test("serves the auth.md skill manifest as markdown", async () => {
    const response = await agentAuthRoute.handle(
      new Request(`http://localhost${AGENT_AUTH_MANIFEST_PATH}`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/markdown");
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");

    const body = await response.text();
    expect(body).toContain("# stella — agent registration (auth.md)");
    expect(body).toContain("identity_assertion");
  });

  test("answers CORS preflight", async () => {
    const response = await agentAuthRoute.handle(
      new Request(`http://localhost${AGENT_AUTH_MANIFEST_PATH}`, {
        method: "OPTIONS",
      }),
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("Access-Control-Allow-Methods")).toBe(
      "GET, OPTIONS",
    );
  });
});

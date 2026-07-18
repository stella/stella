import { describe, expect, test } from "bun:test";

import { AGENT_AUTH_MANIFEST_PATH } from "@/api/agent-auth/constants";
import { env } from "@/api/env";
import { agentAuthRoute } from "@/api/handlers/agent-auth/routes";

const readManifest = async () =>
  (
    await agentAuthRoute.handle(
      new Request(`http://localhost${AGENT_AUTH_MANIFEST_PATH}`),
    )
  ).text();

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
    expect(body).toContain("service_auth");
  });

  test("lists identity_assertion only when the ID-JAG flag is on", async () => {
    const original = env.FEATURE_AGENT_ID_JAG;
    try {
      // Dark-launched off: the manifest must not advertise a flow the
      // identity route 403s and the AS metadata hides.
      env.FEATURE_AGENT_ID_JAG = false;
      expect(await readManifest()).not.toContain("identity_assertion");

      env.FEATURE_AGENT_ID_JAG = true;
      expect(await readManifest()).toContain("identity_assertion");
    } finally {
      env.FEATURE_AGENT_ID_JAG = original;
    }
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

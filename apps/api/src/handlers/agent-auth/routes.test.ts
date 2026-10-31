import { afterAll, describe, expect, test } from "bun:test";

import {
  AGENT_AUTH_CLAIM_PATH,
  AGENT_AUTH_CONFIRM_PATH,
  AGENT_AUTH_EVENTS_PATH,
  AGENT_AUTH_IDENTITY_PATH,
  AGENT_AUTH_MANIFEST_PATH,
  AGENT_AUTH_TOKEN_PATH,
} from "@/api/agent-auth/constants";
import { apiRoutes } from "@/api/api-routes";
import { env } from "@/api/env";
import {
  agentAuthConfirmRoute,
  agentAuthRoute,
} from "@/api/handlers/agent-auth/routes";
import { createHttpApp } from "@/api/http/app";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { serveForTest } from "@/api/tests/helpers/test-server";

const server = serveForTest(
  createHttpApp({ routes: agentAuthRoute, middleware: [errorBoundary] }),
);
afterAll(async () => {
  await server.stop();
});

const readManifest = async () =>
  (
    await server.fetch(
      new Request(`http://localhost${AGENT_AUTH_MANIFEST_PATH}`),
    )
  ).text();

describe("agent-auth manifest route", () => {
  test("serves the auth.md skill manifest as markdown", async () => {
    const response = await server.fetch(
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
    const response = await server.fetch(
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

describe("agent-auth production mount", () => {
  const mounted = (path: string) =>
    apiRoutes.filter((entry) => entry.path === path);

  test("charges every pre-auth endpoint to one dedicated budget and confirm to its own", () => {
    const preAuthPaths = [
      AGENT_AUTH_MANIFEST_PATH,
      AGENT_AUTH_IDENTITY_PATH,
      AGENT_AUTH_CLAIM_PATH,
      AGENT_AUTH_TOKEN_PATH,
      AGENT_AUTH_EVENTS_PATH,
    ];
    const preAuth = preAuthPaths.flatMap(mounted);
    expect(
      preAuth.map(({ method, path }) => `${method} ${path}`).toSorted(),
    ).toEqual(
      agentAuthRoute.map(({ method, path }) => `${method} ${path}`).toSorted(),
    );
    const [budget] = preAuth[0]?.middleware ?? [];
    expect(budget).toBeFunction();
    for (const entry of preAuth) {
      expect(entry.middleware).toHaveLength(1);
      expect(entry.middleware[0]).toBe(budget);
    }

    const confirm = mounted(AGENT_AUTH_CONFIRM_PATH);
    expect(confirm.map(({ method }) => method)).toEqual(
      agentAuthConfirmRoute.map(({ method }) => method),
    );
    for (const entry of confirm) {
      expect(entry.middleware).toHaveLength(1);
      expect(entry.middleware).not.toContain(budget);
    }
  });
});

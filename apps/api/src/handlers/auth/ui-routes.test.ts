import { afterAll, describe, expect, test } from "bun:test";

import { env } from "@/api/env";
import {
  authUiRoute,
  OAUTH_UI_CONSENT_PATH,
  OAUTH_UI_LOGIN_PATH,
  OAUTH_UI_ORGANIZATION_PATH,
} from "@/api/handlers/auth/ui-routes";
import { createHttpApp } from "@/api/http/app";
import { errorBoundary } from "@/api/lib/observability/request-lifecycle";
import { serveForTest } from "@/api/tests/helpers/test-server";

const server = serveForTest(
  createHttpApp({ routes: authUiRoute, middleware: [errorBoundary] }),
);
afterAll(async () => {
  await server.stop();
});

describe("OAuth UI routes", () => {
  test.each([
    [OAUTH_UI_LOGIN_PATH, "/auth"],
    [OAUTH_UI_ORGANIZATION_PATH, "/auth/organization"],
    [OAUTH_UI_CONSENT_PATH, "/consent"],
  ])("preserves the exact signed query for %s", async (route, frontendPath) => {
    const rawQuery =
      "client_id=test&ba_param=client_id&ba_param=scope&scope=stella%3Aread&sig=signed%2Bvalue%3D";
    const response = await server.fetch(
      new Request(`http://localhost${route}?${rawQuery}`, {
        redirect: "manual",
      }),
    );

    expect(response.status).toBe(302);
    const location = response.headers.get("location");
    expect(location).not.toBeNull();

    const redirect = new URL(location ?? "http://invalid");
    expect(`${redirect.origin}${redirect.pathname}`).toBe(
      `${env.FRONTEND_URL}${frontendPath}`,
    );
    expect(new URLSearchParams(redirect.hash.slice(1)).get("oauth_query")).toBe(
      rawQuery,
    );
    expect(redirect.search).toBe("");
  });
});

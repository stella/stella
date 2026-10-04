import { describe, expect, test } from "bun:test";
import { Elysia, t } from "elysia";

import { deploymentFeatureGate } from "@/api/lib/deployment-feature-route";

const request = () => new Request("http://localhost/feature");

describe("deploymentFeatureGate", () => {
  test("returns 404 without executing a disabled route", async () => {
    let executed = false;
    const app = new Elysia()
      .use(deploymentFeatureGate(() => false))
      .get("/feature", () => {
        executed = true;
        return { ok: true };
      });

    const response = await app.handle(request());

    expect(response.status).toBe(404);
    expect(executed).toBe(false);
  });

  test("answers 404, not a validation error, for a malformed request", async () => {
    const app = new Elysia()
      .use(deploymentFeatureGate(() => false))
      .get("/feature", () => ({ ok: true }), {
        query: t.Object({ q: t.String({ minLength: 1 }) }),
      });

    const response = await app.handle(request());

    expect(response.status).toBe(404);
  });

  test("leaves an enabled route runnable", async () => {
    const app = new Elysia()
      .use(deploymentFeatureGate(() => true))
      .get("/feature", () => ({ ok: true }));

    const response = await app.handle(request());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});

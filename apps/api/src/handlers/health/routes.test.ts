import { describe, expect, test } from "bun:test";

import { createHealthRoute } from "@/api/handlers/health/routes";

describe("health routes", () => {
  test("liveness and compatibility health do not touch dependencies", async () => {
    let readinessCalls = 0;
    const route = createHealthRoute({
      probeReadiness: async () => {
        readinessCalls++;
        return { status: "not-ready", failed: ["database"] };
      },
    });

    const responses = await Promise.all(
      ["live", "health"].map(async (path) => {
        const response = await route.handle(
          new Request(`http://localhost/${path}`),
        );
        return { body: await response.json(), status: response.status };
      }),
    );
    for (const response of responses) {
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ status: "ok" });
    }
    expect(readinessCalls).toBe(0);
  });

  test("readiness fails closed", async () => {
    let readinessCalls = 0;
    const route = createHealthRoute({
      probeReadiness: async () => {
        readinessCalls++;
        return { status: "not-ready", failed: ["object-storage"] };
      },
    });

    const response = await route.handle(new Request("http://localhost/ready"));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      status: "error",
      message: "Required dependency unavailable",
    });
    expect(readinessCalls).toBe(1);
  });

  test("turns an unexpected probe rejection into a generic 503", async () => {
    const route = createHealthRoute({
      probeReadiness: async () => {
        throw new Error("private dependency detail");
      },
    });

    const response = await route.handle(new Request("http://localhost/ready"));
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private dependency detail");
  });
});

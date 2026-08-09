import { describe, expect, test } from "bun:test";

import { createHealthRoute } from "@/api/handlers/health/routes";

describe("health routes", () => {
  test("liveness reports the process without touching dependencies", async () => {
    let readinessCalls = 0;
    const route = createHealthRoute({
      probeReadiness: async () => {
        readinessCalls++;
        return { status: "not-ready", failed: ["database"] };
      },
    });

    const response = await route.handle(new Request("http://localhost/live"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok" });
    expect(readinessCalls).toBe(0);
  });

  test("readiness and the compatibility health path fail closed", async () => {
    let readinessCalls = 0;
    const route = createHealthRoute({
      probeReadiness: async () => {
        readinessCalls++;
        return { status: "not-ready", failed: ["object-storage"] };
      },
    });

    const results = await Promise.all(
      ["ready", "health"].map(async (path) => {
        const response = await route.handle(
          new Request(`http://localhost/${path}`),
        );
        return { body: await response.json(), status: response.status };
      }),
    );
    for (const result of results) {
      expect(result.status).toBe(503);
      expect(result.body).toMatchObject({
        status: "error",
        message: "Required dependency unavailable",
      });
    }
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

import { describe, expect, test } from "bun:test";

import { publicCaseLawRoute } from "@/api/handlers/case-law/public-routes";

describe("public case-law routes", () => {
  test("rejects invalid public search source IDs before handler execution", async () => {
    const response = await publicCaseLawRoute.handle(
      new Request("http://localhost/case/decisions/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "shareholder dispute",
          sourceId: "not-a-uuid",
        }),
      }),
    );

    expect(response.status).toBe(422);
  });
});

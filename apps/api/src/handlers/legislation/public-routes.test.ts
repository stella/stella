import { describe, expect, test } from "bun:test";

import { publicLegislationRoute } from "@/api/handlers/legislation/public-routes";

describe("public statute routes", () => {
  test("rejects a document id that is not a UUID before handler execution", async () => {
    const response = await publicLegislationRoute.handle(
      new Request("http://localhost/law/statutes/not-a-uuid"),
    );

    expect(response.status).toBe(422);
  });

  test("requires the country a statute listing is scoped to", async () => {
    const response = await publicLegislationRoute.handle(
      new Request("http://localhost/law/statutes"),
    );

    expect(response.status).toBe(422);
  });

  test("rejects a list cursor that is not a title/id pair", async () => {
    const response = await publicLegislationRoute.handle(
      new Request(
        "http://localhost/law/statutes?country=CZE&cursor=not-a-cursor",
      ),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "Invalid cursor" });
  });
});

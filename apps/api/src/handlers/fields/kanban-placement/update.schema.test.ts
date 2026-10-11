import { expect, test } from "bun:test";
import { Elysia } from "elysia";

import { createSafeId } from "@/api/lib/branded-types";

import updateKanbanPlacement from "./update";

const app = new Elysia().patch("/placement", ({ body }) => body, {
  body: updateKanbanPlacement.config.body,
});

const requestPlacement = async (body: unknown) =>
  await app.handle(
    new Request("http://localhost/placement", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

test("task status moves require the observed task version", async () => {
  const body = {
    entityId: createSafeId<"entity">(),
    status: "done",
    fields: [],
  };
  for (const expectedUpdatedAt of [undefined, null, "invalid"]) {
    const response = await requestPlacement({ ...body, expectedUpdatedAt });
    expect(response.status).toBe(422);
  }
  const versioned = { ...body, expectedUpdatedAt: "2026-01-01T00:00:00.000Z" };
  const response = await requestPlacement(versioned);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(versioned);
});

test("property-only moves remain independent of task versions", async () => {
  const body = {
    entityId: createSafeId<"entity">(),
    fields: [
      {
        propertyId: createSafeId<"property">(),
        content: { type: "text", version: 1, value: "Review" },
      },
    ],
  };
  const response = await requestPlacement(body);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(body);
  const unusedToken = await requestPlacement({
    ...body,
    expectedUpdatedAt: "2026-01-01T00:00:00.000Z",
  });
  expect(unusedToken.status).toBe(422);
});

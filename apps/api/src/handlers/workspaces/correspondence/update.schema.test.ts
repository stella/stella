import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import { CORRESPONDENCE_HANDLING_STATES } from "@stll/api-contract/correspondence";

import updateCorrespondence from "./update";

const app = new Elysia().patch("/correspondence", ({ body }) => body, {
  body: updateCorrespondence.config.body,
});

describe("correspondence handling HTTP schema", () => {
  test("assignment-only requests leave handling state absent", async () => {
    const response = await app.handle(
      new Request("http://localhost/correspondence", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ assigneeId: null }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ assigneeId: null });
  });

  test("every handling state round-trips without adding an assignment", async () => {
    for (const handlingState of CORRESPONDENCE_HANDLING_STATES) {
      const body = { handlingState };
      const response = await app.handle(
        new Request("http://localhost/correspondence", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(body);
    }
  });
});

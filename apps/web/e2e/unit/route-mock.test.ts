import type { Route } from "@playwright/test";
import { describe, expect, test } from "bun:test";

import { mcpHandoffRedeemResultSchema } from "@stll/api-contract/mcp-web-handoff";

import {
  apiError,
  contractJson,
  respond,
  staticBody,
} from "../helpers/route-mock";

type FulfillOptions = Parameters<Route["fulfill"]>[0];

/** A route that keeps what it was answered with. */
const recordingRoute = () => {
  const answers: FulfillOptions[] = [];
  return {
    answers,
    route: {
      fulfill: async (options?: FulfillOptions) => {
        answers.push(options);
      },
    },
  };
};

describe("route mocks", () => {
  test("a reply reaches the route as built", async () => {
    const { answers, route } = recordingRoute();
    await respond(route, apiError(503, { message: "Unavailable" }));
    await respond(
      route,
      staticBody({ contentType: "text/html", body: "<p>Page</p>" }),
    );
    expect(answers).toEqual([
      { status: 503, json: { message: "Unavailable" } },
      { contentType: "text/html", body: "<p>Page</p>" },
    ]);
  });

  test("a body that no longer matches its shared contract fails at the mock", () => {
    expect(() =>
      contractJson(mcpHandoffRedeemResultSchema, { status: "refused" }),
    ).not.toThrow();
    const stale: unknown = { status: "confirmed" };
    expect(() =>
      contractJson(mcpHandoffRedeemResultSchema, stale as never),
    ).toThrow("Mocked response does not match its contract");
  });

  test.each(["application/json", "Application/JSON", "application/ld+json"])(
    "a static body refuses the JSON content type %s",
    (contentType) => {
      expect(() =>
        staticBody({ contentType: contentType as "text/plain", body: "{}" }),
      ).toThrow("use apiJson, contractJson or authJson for a JSON body");
    },
  );

  test("a static body refuses a content type set through a header", () => {
    expect(() =>
      staticBody({
        contentType: "text/plain",
        body: "{}",
        headers: { "Content-Type": "application/json" },
      }),
    ).toThrow("Set a static body's content type with `contentType`");
  });
});

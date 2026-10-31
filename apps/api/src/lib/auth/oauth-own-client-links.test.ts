import { describe, expect, test } from "bun:test";

import {
  ownNativeClientResourceLinks,
  ownNativeClientResources,
} from "@/api/lib/auth/oauth-own-client-links";

describe("stella's own app clients", () => {
  test("an https deployment links the app's document client, and only it, to the REST API", () => {
    const origin = "https://stella-api.example.test";
    const mobile = `${origin}/v1/mcp/oauth/mobile-client-metadata.json`;
    expect(ownNativeClientResourceLinks(origin)).toEqual([
      { clientId: mobile, resourceId: `${origin}/v1` },
    ]);
    expect(ownNativeClientResources(origin, mobile)).toEqual([`${origin}/v1`]);
    expect(
      ownNativeClientResources(
        origin,
        `${origin}/v1/mcp/oauth/cli-client-metadata.json`,
      ),
    ).toEqual([]);
    expect(
      ownNativeClientResources(
        origin,
        "https://elsewhere.example.test/v1/mcp/oauth/mobile-client-metadata.json",
      ),
    ).toEqual([]);
  });

  test("an http deployment has no document client to link", () => {
    expect(ownNativeClientResourceLinks("http://localhost:3001")).toEqual([]);
  });
});

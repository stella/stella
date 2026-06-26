import { describe, expect, test } from "bun:test";

import { buildSelfHostConnectDeepLink } from "@/lib/desktop-self-host-link.logic";

describe("self-host desktop link", () => {
  test("encodes web origin and API base URL", () => {
    expect(
      buildSelfHostConnectDeepLink({
        apiBaseUrl: "https://api-production.example",
        webOrigin: "https://web-production.example",
      }),
    ).toBe(
      "stella://self-host/connect?apiBaseUrl=https%3A%2F%2Fapi-production.example&webOrigin=https%3A%2F%2Fweb-production.example",
    );
  });
});

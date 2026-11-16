import { describe, expect, test } from "bun:test";

import { apiFetchUrl } from "@/env";

describe("apiFetchUrl", () => {
  test("routes API-origin URLs through the development proxy", () => {
    const config = { apiFetchBase: "/api", apiOrigin: "http://localhost:3001" };

    expect(
      apiFetchUrl("http://localhost:3001/api/auth/oauth2/token", config),
    ).toBe("/api/api/auth/oauth2/token");
    expect(
      apiFetchUrl(
        "http://localhost:3001/.well-known/oauth-authorization-server?x=1",
        config,
      ),
    ).toBe("/api/.well-known/oauth-authorization-server?x=1");
    expect(apiFetchUrl("https://objects.example.test/put", config)).toBe(
      "https://objects.example.test/put",
    );
  });

  test("leaves URLs alone when the API is called directly", () => {
    const config = {
      apiFetchBase: "https://api.stll.app",
      apiOrigin: "https://api.stll.app",
    };

    expect(
      apiFetchUrl("https://api.stll.app/api/auth/oauth2/token", config),
    ).toBe("https://api.stll.app/api/auth/oauth2/token");
  });
});

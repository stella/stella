import { describe, expect, test } from "bun:test";

import { isSkillSourceRateLimitedRequest } from "./source-rate-limit";

const request = (method: string, path: string) => ({
  method,
  url: `https://stella.example${path}`,
});

describe("skill source rate-limit routing", () => {
  test("matches outbound skill discovery and import requests", () => {
    expect(
      isSkillSourceRateLimitedRequest(
        request("POST", "/v1/skills/discover-url"),
      ),
    ).toBe(true);
    expect(
      isSkillSourceRateLimitedRequest(request("POST", "/v1/skills/import-url")),
    ).toBe(true);
    expect(
      isSkillSourceRateLimitedRequest(
        request("POST", "/v1/skills/import-urls/"),
      ),
    ).toBe(true);
  });

  test("leaves other skill requests outside the source-fetch budget", () => {
    expect(isSkillSourceRateLimitedRequest(request("POST", "/v1/skills"))).toBe(
      false,
    );
    expect(
      isSkillSourceRateLimitedRequest(
        request("GET", "/v1/skills/discover-url"),
      ),
    ).toBe(false);
  });
});

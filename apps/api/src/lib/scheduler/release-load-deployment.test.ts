import { describe, expect, test } from "bun:test";

import { releaseLoadAllowed } from "./release-load-deployment";

describe("the release load's deployment gate", () => {
  test("the staging API admits it", () => {
    expect(releaseLoadAllowed("https://api-staging.stll.app")).toBe(true);
    expect(releaseLoadAllowed("https://api-staging.stll.app/")).toBe(true);
  });

  test("the production API refuses it", () => {
    expect(releaseLoadAllowed("https://api.stll.app")).toBe(false);
    expect(releaseLoadAllowed("https://api.stll.app/")).toBe(false);
  });

  test("an unknown, missing or malformed origin refuses it", () => {
    for (const publicUrl of [
      undefined,
      "",
      "not a url",
      "http://api-staging.stll.app",
      "https://api-staging.stll.app.example.com",
      "https://staging.stll.app",
      "http://localhost:3001",
    ]) {
      expect(releaseLoadAllowed(publicUrl), String(publicUrl)).toBe(false);
    }
  });
});

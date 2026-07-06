import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { resolveStamp } from "@/api/lib/version";

describe("resolveStamp", () => {
  let savedRailwaySha: string | undefined;

  beforeEach(() => {
    savedRailwaySha = process.env["RAILWAY_GIT_COMMIT_SHA"];
    delete process.env["RAILWAY_GIT_COMMIT_SHA"];
  });

  afterEach(() => {
    if (savedRailwaySha === undefined) {
      delete process.env["RAILWAY_GIT_COMMIT_SHA"];
    } else {
      process.env["RAILWAY_GIT_COMMIT_SHA"] = savedRailwaySha;
    }
  });

  test("explicit build-arg value wins over the Railway fallback", () => {
    process.env["RAILWAY_GIT_COMMIT_SHA"] = "railway-sha";
    expect(resolveStamp("v1.2.3")).toBe("v1.2.3");
  });

  test("the Dockerfile default 'dev' defers to the Railway commit SHA", () => {
    process.env["RAILWAY_GIT_COMMIT_SHA"] = "railway-sha";
    expect(resolveStamp("dev")).toBe("railway-sha");
    expect(resolveStamp(undefined)).toBe("railway-sha");
  });

  test("empty string is treated as absent, not as a version", () => {
    process.env["RAILWAY_GIT_COMMIT_SHA"] = "railway-sha";
    expect(resolveStamp("")).toBe("railway-sha");

    process.env["RAILWAY_GIT_COMMIT_SHA"] = "";
    expect(resolveStamp("")).toBe("dev");
  });

  test("falls back to 'dev' outside any release flow", () => {
    expect(resolveStamp(undefined)).toBe("dev");
    expect(resolveStamp("dev")).toBe("dev");
  });
});

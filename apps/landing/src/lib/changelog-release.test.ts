import { describe, expect, test } from "bun:test";

import { getReleaseKind, isStellaReleaseTag } from "./changelog-release";

describe("Stella changelog releases", () => {
  test("accepts stable stella release tags", () => {
    expect(isStellaReleaseTag("v0.6.1")).toBe(true);
    expect(isStellaReleaseTag("v12.34.56")).toBe(true);
  });

  test("rejects package releases and prereleases", () => {
    expect(isStellaReleaseTag("@stll/template-conditions@0.2.0")).toBe(false);
    expect(isStellaReleaseTag("@stll/conditions@0.3.0")).toBe(false);
    expect(isStellaReleaseTag("v0.7.0-rc.1")).toBe(false);
  });

  test("classifies stella versions", () => {
    expect(getReleaseKind("v1.0.0")).toBe("major");
    expect(getReleaseKind("v1.2.0")).toBe("minor");
    expect(getReleaseKind("v1.2.3")).toBe("patch");
  });
});

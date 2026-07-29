import { describe, expect, test } from "bun:test";

import { isExternalSharePath } from "./external-share-privacy";

describe("external Share Space privacy boundary", () => {
  test("recognizes invitation and token-free viewer paths only", () => {
    expect(isExternalSharePath("/share/invitation-secret")).toBe(true);
    expect(isExternalSharePath("/shared/share-space-id")).toBe(true);
    expect(isExternalSharePath("/share")).toBe(false);
    expect(isExternalSharePath("/workspaces/share/example")).toBe(false);
  });
});

import { describe, expect, test } from "bun:test";

import { readDesktopRegistryNonce } from "@/lib/desktop-bridge";

describe("desktop registry handoff hash", () => {
  test("accepts a UUID nonce and rejects other hash values", () => {
    const nonce = "123e4567-e89b-42d3-a456-426614174000";

    expect(readDesktopRegistryNonce(`#desktop-registry=${nonce}`)).toBe(nonce);
    expect(readDesktopRegistryNonce("#desktop-registry=not-a-uuid")).toBeNull();
    expect(readDesktopRegistryNonce(`#other=${nonce}`)).toBeNull();
  });
});


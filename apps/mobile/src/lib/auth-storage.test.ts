import { describe, expect, test } from "bun:test";

import { mobileAuthStoragePrefix } from "./auth-storage";

describe("mobileAuthStoragePrefix", () => {
  test("is deterministic and valid for SecureStore keys", () => {
    const prefix = mobileAuthStoragePrefix("https://api.example.com/");

    expect(prefix).toBe(mobileAuthStoragePrefix("https://api.example.com/"));
    expect(prefix).toMatch(/^[\w.-]+$/u);
  });

  test("isolates credentials across API origins and self-hosted paths", () => {
    const primary = mobileAuthStoragePrefix("https://api.example.com/stella/");

    expect(primary).not.toBe(
      mobileAuthStoragePrefix("https://other.example.com/stella/"),
    );
    expect(primary).not.toBe(
      mobileAuthStoragePrefix("https://api.example.com/other/"),
    );
  });
});
